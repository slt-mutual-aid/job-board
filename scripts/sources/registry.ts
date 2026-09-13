import { leverAdapter, type LeverConfig } from "./adapters/lever";
import { bambooHrAdapter, type BambooHrConfig } from "./adapters/bamboohr";
import { icimsAdapter, type IcimsConfig } from "./adapters/icims";

const leverConfig: LeverConfig = {
  company: "insomniacookies",
  location: "South Lake Tahoe CA",
};

const bambooHrConfig: BambooHrConfig = {
  subdomain: "vra",
  city: "South Lake Tahoe",
};

// The venue sits in Stateline, which is inside the search radius and outside
// California.
const icimsOvgConfig: IcimsConfig = {
  host: "careers-ovg.icims.com",
  searchZip: "96150",
  searchRadiusMiles: 20,
  linkHosts: ["careers-ovg.icims.com"],
  locations: ["US-NV-Stateline"],
};

// jobs-davidsonhospitality.icims.com answers the same search, and its results
// link onward to careers- and management- hosts rather than to itself.
const icimsDavidsonConfig: IcimsConfig = {
  host: "careers-davidsonhospitality.icims.com",
  searchZip: "96150",
  searchRadiusMiles: 20,
  linkHosts: [
    "careers-davidsonhospitality.icims.com",
    "jobs-davidsonhospitality.icims.com",
  ],
  locations: ["US-CA-South Lake Tahoe"],
};

// sourceId names one employer's listing, which is what a health record, a
// reconciliation report, and a contract case are each about. It is not the
// adapter id: one adapter reads both iCIMS accounts, and a health file keyed by
// the adapter would hold one record for two employers.
//
// accountId namespaces every posting key recorded for the source. It names the
// account rather than the platform, so two accounts on one platform cannot hand
// out a key that overwrites the other.
export const leverSource = {
  adapter: leverAdapter,
  config: leverConfig,
  sourceId: "lever",
  accountId: `lever:${leverConfig.company}`,
};

export const bambooHrSource = {
  adapter: bambooHrAdapter,
  config: bambooHrConfig,
  sourceId: "bamboohr",
  accountId: `bamboohr:${bambooHrConfig.subdomain}`,
};

export const icimsOvgSource = {
  adapter: icimsAdapter,
  config: icimsOvgConfig,
  sourceId: "icims:ovg",
  accountId: `icims:${icimsOvgConfig.host}`,
};

export const icimsDavidsonSource = {
  adapter: icimsAdapter,
  config: icimsDavidsonConfig,
  sourceId: "icims:davidson",
  accountId: `icims:${icimsDavidsonConfig.host}`,
};

// Every source this project reads. A source missing from this list is a source
// the shared contract test never runs against.
export const sources = [
  leverSource,
  bambooHrSource,
  icimsOvgSource,
  icimsDavidsonSource,
];
