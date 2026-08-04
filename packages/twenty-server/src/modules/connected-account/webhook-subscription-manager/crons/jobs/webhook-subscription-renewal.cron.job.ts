import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import {
  WebhookSubscriptionChannelType,
  WebhookSubscriptionStatus,
} from 'twenty-shared/types';
import { WorkspaceActivationStatus } from 'twenty-shared/workspace';
import {
  type FindManyOptions,
  In,
  IsNull,
  LessThanOrEqual,
  Repository,
} from 'typeorm';

import { SentryCronMonitor } from 'src/engine/core-modules/cron/sentry-cron-monitor.decorator';
import { InjectMessageQueue } from 'src/engine/core-modules/message-queue/decorators/message-queue.decorator';
import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import { CalendarChannelEntity } from 'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity';
import { MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';
import { isThrottled } from 'src/modules/connected-account/utils/is-throttled';
import { WEBHOOK_SUBSCRIPTION_RENEWAL_BUFFER_MS } from 'src/modules/connected-account/webhook-subscription-manager/constants/webhook-subscription-renewal-buffer-ms.constant';
import { WEBHOOK_SUBSCRIPTION_RENEWAL_CRON_PATTERN } from 'src/modules/connected-account/webhook-subscription-manager/constants/webhook-subscription-renewal-cron-pattern.constant';
import { WEBHOOK_SUBSCRIPTION_THROTTLE_DURATION } from 'src/modules/connected-account/webhook-subscription-manager/constants/webhook-subscription-throttle-duration.constant';
import {
  RenewWebhookSubscriptionJob,
  type RenewWebhookSubscriptionJobData,
} from 'src/modules/connected-account/webhook-subscription-manager/jobs/renew-webhook-subscription.job';
import { toIsoStringOrNull } from 'src/utils/date/toIsoStringOrNull';

type WebhookSubscribableChannel = MessageChannelEntity | CalendarChannelEntity;

type StaleChannel = Pick<
  WebhookSubscribableChannel,
  | 'id'
  | 'workspaceId'
  | 'webhookSubscriptionFailedAt'
  | 'webhookSubscriptionFailureCount'
>;

@Processor(MessageQueue.cronQueue)
export class WebhookSubscriptionRenewalCronJob {
  private readonly logger = new Logger(WebhookSubscriptionRenewalCronJob.name);

  constructor(
    @InjectRepository(WorkspaceEntity)
    private readonly workspaceRepository: Repository<WorkspaceEntity>,
    @InjectRepository(MessageChannelEntity)
    private readonly messageChannelRepository: Repository<MessageChannelEntity>,
    @InjectRepository(CalendarChannelEntity)
    private readonly calendarChannelRepository: Repository<CalendarChannelEntity>,
    @InjectMessageQueue(MessageQueue.webhookQueue)
    private readonly webhookQueueService: MessageQueueService,
  ) {}

  @Process(WebhookSubscriptionRenewalCronJob.name)
  @SentryCronMonitor(
    WebhookSubscriptionRenewalCronJob.name,
    WEBHOOK_SUBSCRIPTION_RENEWAL_CRON_PATTERN,
  )
  async handle(): Promise<void> {
    const activeWorkspaces = await this.workspaceRepository.find({
      where: { activationStatus: WorkspaceActivationStatus.ACTIVE },
      select: { id: true },
    });

    const activeWorkspaceIds = activeWorkspaces.map(
      (workspace) => workspace.id,
    );

    if (activeWorkspaceIds.length === 0) {
      return;
    }

    const [messageChannels, calendarChannels] = await Promise.all([
      this.findStaleChannels(this.messageChannelRepository, activeWorkspaceIds),
      this.findStaleChannels(
        this.calendarChannelRepository,
        activeWorkspaceIds,
      ),
    ]);

    const messageChannelsToRenew = this.excludeThrottledChannels(
      WebhookSubscriptionChannelType.MESSAGING,
      messageChannels,
    );
    const calendarChannelsToRenew = this.excludeThrottledChannels(
      WebhookSubscriptionChannelType.CALENDAR,
      calendarChannels,
    );

    if (
      messageChannelsToRenew.length === 0 &&
      calendarChannelsToRenew.length === 0
    ) {
      return;
    }

    await Promise.all([
      this.enqueueRenewals(
        WebhookSubscriptionChannelType.MESSAGING,
        messageChannelsToRenew,
      ),
      this.enqueueRenewals(
        WebhookSubscriptionChannelType.CALENDAR,
        calendarChannelsToRenew,
      ),
    ]);

    this.logger.log(
      `Enqueued webhook subscription renewals: ${messageChannelsToRenew.length} messaging, ${calendarChannelsToRenew.length} calendar`,
    );
  }

  private findStaleChannels<TChannel extends WebhookSubscribableChannel>(
    repository: Repository<TChannel>,
    activeWorkspaceIds: string[],
  ): Promise<StaleChannel[]> {
    const workspaceScope = {
      workspaceId: In(activeWorkspaceIds),
      connectedAccount: { authFailedAt: IsNull() },
    };
    const renewalThreshold = new Date(
      Date.now() + WEBHOOK_SUBSCRIPTION_RENEWAL_BUFFER_MS,
    );

    const options: FindManyOptions<WebhookSubscribableChannel> = {
      where: [
        {
          ...workspaceScope,
          webhookSubscriptionStatus: WebhookSubscriptionStatus.FAILED,
        },
        {
          ...workspaceScope,
          webhookSubscriptionStatus: WebhookSubscriptionStatus.ACTIVE,
          webhookSubscriptionExpiresAt: LessThanOrEqual(renewalThreshold),
        },
      ],
      select: {
        id: true,
        workspaceId: true,
        webhookSubscriptionFailedAt: true,
        webhookSubscriptionFailureCount: true,
      },
    };

    return repository.find(options as FindManyOptions<TChannel>);
  }

  private excludeThrottledChannels(
    channelType: WebhookSubscriptionChannelType,
    channels: StaleChannel[],
  ): StaleChannel[] {
    const channelsToRenew = channels.filter(
      (channel) =>
        !isThrottled(
          toIsoStringOrNull(channel.webhookSubscriptionFailedAt),
          channel.webhookSubscriptionFailureCount,
          null,
          WEBHOOK_SUBSCRIPTION_THROTTLE_DURATION,
        ),
    );

    const throttledCount = channels.length - channelsToRenew.length;

    if (throttledCount > 0) {
      this.logger.log(
        `Skipped ${throttledCount} throttled ${channelType} channels`,
      );
    }

    return channelsToRenew;
  }

  private async enqueueRenewals(
    channelType: WebhookSubscriptionChannelType,
    channels: StaleChannel[],
  ): Promise<void> {
    for (const channel of channels) {
      await this.webhookQueueService.add<RenewWebhookSubscriptionJobData>(
        RenewWebhookSubscriptionJob.name,
        {
          channelType,
          channelId: channel.id,
          workspaceId: channel.workspaceId,
        },
        {
          id: `${RenewWebhookSubscriptionJob.name}:${channelType}:${channel.id}`,
        },
      );
    }
  }
}
