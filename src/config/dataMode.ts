// True when the UI runs on the fixture-backed mock client; false when it talks to the real backend.
export const IS_MOCK = import.meta.env["VITE_USE_MOCK"] !== "false";
