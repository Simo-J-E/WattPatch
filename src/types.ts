export const FIXTURE_TYPES = [
  "Moving-head spot",
  "Moving-head wash",
  "Moving-head beam",
  "Moving-head hybrid",
  "LED PAR",
  "Conventional PAR",
  "Fresnel",
  "Profile",
  "Followspot",
  "Blinder",
  "Sunstrip",
  "Strobe",
  "LED bar",
  "Pixel bar",
  "Effect light",
  "Laser",
  "Practical light",
  "Dimmer channel",
  "Custom electrical load",
  "Hazer",
  "Fog machine",
] as const;

export const COMMON_MANUFACTURERS = [
  "Robe",
  "Martin",
  "ETC",
  "Showtec",
  "Chauvet Professional",
  "Chauvet DJ",
  "ADJ",
  "Cameo",
  "Elation",
  "Claypaky",
  "Ayrton",
  "GLP",
  "Astera",
  "Aputure",
  "ARRI",
  "Vari-Lite",
  "Eurolite",
  "SGM",
  "Portman",
] as const;

export type FixtureType = (typeof FIXTURE_TYPES)[number];
export type Phase = "" | "L1" | "L2" | "L3";
export type VerificationStatus = "verified" | "estimated";

export interface FixtureDefinition {
  id: string;
  manufacturer: string;
  model: string;
  category: FixtureType;
  maxPowerW: number;
  ratedCurrentA: number | null;
  ratedCurrentVoltageV: number | null;
  maxVA: number | null;
  supportedVoltage: string;
  powerFactor: number | null;
  inrushCurrentA: number | null;
  lampCount: number | null;
  lampWattage: number | null;
  internalBasePowerW: number | null;
  removableLamps: boolean;
  partialLoadVerified: boolean;
  sourceUrl: string;
  verificationDate: string;
  status: VerificationStatus;
  estimationNote: string | null;
}

export interface ProjectFixture {
  id: string;
  definitionId: string;
  quantity: number;
  activeLampCount: number | null;
  assignments: Array<string | null>;
  lockedCircuitId: string | null;
  groupName: string;
}

export interface Circuit {
  id: string;
  name: string;
  breakerA: number;
  enabled: boolean;
  phase: Phase;
}

export interface Project {
  id: string;
  name: string;
  voltageV: number;
  frequencyHz: number;
  reservePercentage: number;
  circuits: Circuit[];
  fixtures: ProjectFixture[];
  customFixtures: FixtureDefinition[];
  favourites: string[];
  recentFixtureIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CurrentResult {
  currentA: number;
  powerW: number;
  method: "rated-current" | "rated-va" | "watts-pf" | "watts-estimated-pf";
  estimated: boolean;
  removedPowerW: number;
}

export interface OptimizerInput {
  voltageV: number;
  reservePercentage: number;
  circuits: Circuit[];
  fixtures: ProjectFixture[];
  definitions: FixtureDefinition[];
}

export interface OptimizerResult {
  assignments: Record<string, Array<string | null>>;
  unassignedCount: number;
}
