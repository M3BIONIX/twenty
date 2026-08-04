// Base of the exponential backoff between renewal attempts. The renewal cron runs
// hourly, so a shorter base would always be absorbed by the cron schedule.
export const WEBHOOK_SUBSCRIPTION_THROTTLE_DURATION = 1000 * 60 * 60; // 1 hour
