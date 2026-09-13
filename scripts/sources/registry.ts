import { leverAdapter, type LeverConfig } from "./adapters/lever";
import { bambooHrAdapter, type BambooHrConfig } from "./adapters/bamboohr";
import { icimsAdapter, type IcimsConfig } from "./adapters/icims";
import { createOracleAdapter, type OracleConfig } from "./adapters/oracle";
import { ukgAdapter, type UkgConfig } from "./adapters/ukg";

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

// Oracle names the facet after Stateline, and every requisition behind it
// writes its PrimaryLocation as South Lake Tahoe, NV.
const oracleCaesarsConfig: OracleConfig = {
  host: "edmn.fa.us2.oraclecloud.com",
  siteNumber: "CX_1",
  locationFacet: "300000002323814",
  location: "South Lake Tahoe, NV, United States",
};

const oracleRaleysConfig: OracleConfig = {
  host: "fa-epss-saasfaprod1.fa.ocs.oraclecloud.com",
  siteNumber: "CX_1",
  locationFacet: "300000002154145",
  location: "South Lake Tahoe, CA, United States",
};

const ukgConfig: UkgConfig = {
  tenant: "TWI1006TRWH",
  jobBoardId: "b9cc79c4-75a2-4800-8508-16504f7a2d90",
  // Bally's Lake Tahoe stands in Stateline, Nevada, and shares one job board
  // with the rest of a national company.
  city: "Stateline",
  state: "NV",
  robotsOverride: {
    reason:
      "recruiting.ultipro.com allows */JobBoard/ and then forbids */JobBoardView, which is where the search carrying the postings lives. The operator of this board reads it anyway: robots.txt is a convention rather than law, the board is a volunteer project serving one town, and a run is nine requests at the same crawl delay every other source keeps.",
  },
};

// sourceId names one employer's listing, which is what a health record, a
// reconciliation report, and a contract case are each about. It is not the
// adapter id: one adapter reads both iCIMS accounts, and a health file keyed by
// the adapter would hold one record for two employers.
//
// accountId namespaces every posting key recorded for the source. It names the
// account rather than the platform, so two accounts on one platform cannot hand
// out a key that overwrites the other.
//
// companyName fills the board's Company column, which no platform field
// supplies. It is the name jobboard.json already carries for the employer where
// exactly one row names it, so an approved row joins the rows already there
// instead of opening a second spelling of one employer.
export const leverSource = {
  adapter: leverAdapter,
  config: leverConfig,
  sourceId: "lever",
  accountId: `lever:${leverConfig.company}`,
  companyName: "Insomnia Cookies",
};

export const bambooHrSource = {
  adapter: bambooHrAdapter,
  config: bambooHrConfig,
  sourceId: "bamboohr",
  accountId: `bamboohr:${bambooHrConfig.subdomain}`,
  companyName: "VRA",
};

export const icimsOvgSource = {
  adapter: icimsAdapter,
  config: icimsOvgConfig,
  sourceId: "icims:ovg",
  accountId: `icims:${icimsOvgConfig.host}`,
  companyName: "Tahoe Blue Event Center",
};

export const icimsDavidsonSource = {
  adapter: icimsAdapter,
  config: icimsDavidsonConfig,
  sourceId: "icims:davidson",
  accountId: `icims:${icimsDavidsonConfig.host}`,
  companyName: "Davidson Hospitality Group",
};

// A requisition carries no posting URL, so the Oracle adapter builds the apply
// link from the host it read, and parseListing takes no config to read it from.
// Each employer therefore holds an adapter carrying its own config.
export const oracleCaesarsSource = {
  adapter: createOracleAdapter(oracleCaesarsConfig),
  config: oracleCaesarsConfig,
  sourceId: "oracle:caesars",
  accountId: `oracle:${oracleCaesarsConfig.host}`,
  companyName: "Caesars Entertainment",
};

export const oracleRaleysSource = {
  adapter: createOracleAdapter(oracleRaleysConfig),
  config: oracleRaleysConfig,
  sourceId: "oracle:raleys",
  accountId: `oracle:${oracleRaleysConfig.host}`,
  companyName: "Raley's",
};

export const ukgSource = {
  adapter: ukgAdapter,
  config: ukgConfig,
  sourceId: "ukg:ballys",
  accountId: `ukg:${ukgConfig.tenant}`,
  companyName: "Bally's Hotel",
};

// Every source this project reads. A source missing from this list is a source
// the shared contract test never runs against.
export const sources = [
  leverSource,
  bambooHrSource,
  icimsOvgSource,
  icimsDavidsonSource,
  oracleCaesarsSource,
  oracleRaleysSource,
  ukgSource,
];
