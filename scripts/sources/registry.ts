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

export const leverSource = { adapter: leverAdapter, config: leverConfig };

export const bambooHrSource = {
  adapter: bambooHrAdapter,
  config: bambooHrConfig,
};

// Every source this project reads. A source missing from this list is a source
// the shared contract test never runs against.
export const sources = [leverSource, bambooHrSource];
