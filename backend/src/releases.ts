export const latestReleaseAPIURL = "https://api.github.com/repos/finbarr/boxhaven/releases/latest";
export const releaseCheckIntervalMs = 24 * 60 * 60 * 1000;
export const failedReleaseCheckIntervalMs = 60 * 60 * 1000;

const releaseURLPrefix = "https://github.com/finbarr/boxhaven/releases/";
const versionPattern = /^v?(\d+)\.(\d+)\.(\d+)/;

type GitHubRelease = {
  tag_name: string;
  html_url?: string;
};

type CachedRelease = {
  version: string;
  url: string;
};

export type VersionStatus = {
  current_version: string;
  update_available: boolean;
  latest_version?: string;
  release_url?: string;
};

export interface ReleaseUpdateChecker {
  versionStatus(): Promise<VersionStatus>;
}

export class GitHubReleaseChecker implements ReleaseUpdateChecker {
  private cachedRelease?: CachedRelease;
  private nextCheckAt = 0;
  private inFlight?: Promise<void>;

  constructor(
    private readonly currentVersion: string,
    private readonly options: {
      fetcher?: typeof fetch;
      now?: () => number;
      requestTimeoutMs?: number;
    } = {},
  ) {}

  async versionStatus(): Promise<VersionStatus> {
    await this.refreshIfDue();
    const release = this.cachedRelease;
    if (!release) {
      return { current_version: this.currentVersion, update_available: false };
    }
    return {
      current_version: this.currentVersion,
      latest_version: release.version,
      update_available: isNewerVersion(release.version, this.currentVersion),
      release_url: release.url,
    };
  }

  private async refreshIfDue(): Promise<void> {
    const now = this.options.now || Date.now;
    if (now() < this.nextCheckAt) return;
    if (!this.inFlight) {
      this.inFlight = this.refresh().finally(() => {
        this.inFlight = undefined;
      });
    }
    await this.inFlight;
  }

  private async refresh(): Promise<void> {
    const now = this.options.now || Date.now;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? 5_000);
    try {
      const response = await (this.options.fetcher || fetch)(latestReleaseAPIURL, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": `BoxHaven-backend/${this.currentVersion}`,
        },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`latest release request returned HTTP ${response.status}`);
      const payload = await response.json() as Partial<GitHubRelease>;
      const version = comparableVersion(payload.tag_name || "");
      if (!version) throw new Error("latest release is missing a semantic version tag");
      this.cachedRelease = {
        version,
        url: releaseURL(payload, version),
      };
      this.nextCheckAt = now() + releaseCheckIntervalMs;
    } catch {
      // Update discovery is advisory. Keep serving a prior result, if any,
      // and retry later without surfacing network failures to the console.
      this.nextCheckAt = now() + failedReleaseCheckIntervalMs;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function comparableVersion(version: string): string {
  const match = version.trim().match(versionPattern);
  return match ? `v${match[1]}.${match[2]}.${match[3]}` : "";
}

export function isNewerVersion(latestVersion: string, currentVersion: string): boolean {
  const latest = comparableVersion(latestVersion);
  if (!latest) return false;
  const current = comparableVersion(currentVersion);
  if (!current) return true;
  return compareSemver(latest, current) > 0;
}

function compareSemver(left: string, right: string): number {
  const parts = (version: string) => comparableVersion(version)
    .slice(1)
    .split(".")
    .map((part) => Number(part));
  const leftParts = parts(left);
  const rightParts = parts(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] < rightParts[index]) return -1;
    if (leftParts[index] > rightParts[index]) return 1;
  }
  return 0;
}

function releaseURL(release: Partial<GitHubRelease>, version: string): string {
  if (release.html_url?.startsWith(releaseURLPrefix)) return release.html_url;
  return `${releaseURLPrefix}tag/${version}`;
}
