import { mockApi } from "./mock";
import { httpApi } from "./http";
import type { ResearchApi } from "./types";

// Mock by default. Set VITE_USE_MOCK=false to use the HTTP client.
export const api: ResearchApi = import.meta.env['VITE_USE_MOCK'] === "false" ? httpApi : mockApi;
export type { ResearchApi, AskInput, AssessmentInput } from "./types";
