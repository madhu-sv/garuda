/**
 * The git commit that this build came from (0.17). tsup sets it at build time; it is undefined in
 * the tests, which run the sources, and in a build made outside a git checkout.
 */
declare const __GARUDA_BUILD_COMMIT__: string | undefined;

export const BUILD_COMMIT: string | undefined =
  typeof __GARUDA_BUILD_COMMIT__ === "string" && __GARUDA_BUILD_COMMIT__ !== ""
    ? __GARUDA_BUILD_COMMIT__
    : undefined;
