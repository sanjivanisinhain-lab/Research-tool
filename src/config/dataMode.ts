// The app talks to the real backend by default. The built-in demo (sample audiences and answers, no server needed)
// is used only when explicitly asked for with VITE_USE_MOCK=true, e.g. for a design preview or the automated tests.
export const isMockSetting = (value: string | undefined) => value === "true";
export const IS_MOCK = isMockSetting(import.meta.env["VITE_USE_MOCK"]);
