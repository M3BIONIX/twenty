import { relative, sep } from 'path';

export const FRONT_STATIC_ASSET_CACHE_CONTROL =
  'public, max-age=31536000, immutable';

type HeaderResponse = {
  setHeader: (name: string, value: string) => void;
};

export const setFrontStaticAssetHeaders = (
  response: HeaderResponse,
  filePath: string,
  frontPath: string,
): void => {
  const relativeFilePath = relative(frontPath, filePath);
  const [topLevelDirectory] = relativeFilePath.split(sep);

  if (topLevelDirectory === 'assets') {
    response.setHeader('Cache-Control', FRONT_STATIC_ASSET_CACHE_CONTROL);
  }
};
