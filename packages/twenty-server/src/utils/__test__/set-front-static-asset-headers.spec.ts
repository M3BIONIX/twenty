import {
  FRONT_STATIC_ASSET_CACHE_CONTROL,
  setFrontStaticAssetHeaders,
} from 'src/utils/set-front-static-asset-headers';

describe('setFrontStaticAssetHeaders', () => {
  const frontPath = '/app/packages/twenty-server/dist/front';

  it('marks bundled frontend assets as immutable', () => {
    const response = {
      setHeader: jest.fn(),
    };

    setFrontStaticAssetHeaders(
      response,
      `${frontPath}/assets/index-CcEwTNdR.js`,
      frontPath,
    );

    expect(response.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      FRONT_STATIC_ASSET_CACHE_CONTROL,
    );
  });

  it.each([
    `${frontPath}/index.html`,
    `${frontPath}/client-config`,
    `${frontPath}/images/icons/favicon.ico`,
  ])('preserves the existing cache policy for %s', (filePath) => {
    const response = {
      setHeader: jest.fn(),
    };

    setFrontStaticAssetHeaders(response, filePath, frontPath);

    expect(response.setHeader).not.toHaveBeenCalled();
  });
});
