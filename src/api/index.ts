import { mockApi } from "./mock";
import { httpApi } from "./http";
import { IS_MOCK } from "@/config/dataMode";
import type { ResearchApi } from "./types";

// Real backend by default. Set VITE_USE_MOCK=true to use the built-in demo data instead.
export const api: ResearchApi = IS_MOCK ? mockApi : httpApi;
export type { ResearchApi, AskInput, AssessmentInput } from "./types";
