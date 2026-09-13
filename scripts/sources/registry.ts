import { leverAdapter, type LeverConfig } from "./adapters/lever";
import { bambooHrAdapter, type BambooHrConfig } from "./adapters/bamboohr";

const leverConfig: LeverConfig = {
  company: "insomniacookies",
  location: "South Lake Tahoe CA",
};

const bambooHrConfig: BambooHrConfig = {
  subdomain: "vra",
  city: "South Lake Tahoe",
};

// accountId namespaces every posting key recorded for the source. It names the
// account rather than the platform, so two accounts on one platform cannot hand
// out a key that overwrites the other.
export const leverSource = {
  adapter: leverAdapter,
  config: leverConfig,
  accountId: `lever:${leverConfig.company}`,
};

export const bambooHrSource = {
  adapter: bambooHrAdapter,
  config: bambooHrConfig,
  accountId: `bamboohr:${bambooHrConfig.subdomain}`,
};

// Every source this project reads. A source missing from this list is a source
// the shared contract test never runs against.
export const sources = [leverSource, bambooHrSource];
