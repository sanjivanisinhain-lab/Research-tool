import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDictation } from "@/hooks/use-dictation";

class RecognitionStub {
  static current: RecognitionStub | undefined;
  lang = "";
  continuous = false;
  interimResults = false;
  onresult: ((event: { resultIndex: number; results: { isFinal: boolean; 0: { transcript: string } }[] }) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  constructor() { RecognitionStub.current = this; }
  start() {}
  stop() { this.onend?.(); }
  abort() {}
}
afterEach(() => { Reflect.deleteProperty(window, "SpeechRecognition"); Reflect.deleteProperty(window, "webkitSpeechRecognition"); });
describe("question dictation", () => {
  it("returns finalized Hindi speech to the question and keeps interim speech separate", () => {
    Object.defineProperty(window, "SpeechRecognition", { value: RecognitionStub, configurable: true });
    const append = vi.fn();
    const { result } = renderHook(() => useDictation(append));
    act(() => result.current.start("hi-IN"));
    const recognition = RecognitionStub.current;
    expect(recognition?.lang).toBe("hi-IN");
    expect(result.current.listening).toBe(true);
    act(() => recognition?.onresult?.({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: "क्यों" } }] }));
    expect(append).not.toHaveBeenCalled();
    expect(result.current.interim).toBe("क्यों");
    act(() => recognition?.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "लोग कार्ट क्यों छोड़ते हैं?" } }] }));
    expect(append).toHaveBeenCalledWith("लोग कार्ट क्यों छोड़ते हैं?");
    act(() => result.current.stop());
    expect(result.current.listening).toBe(false);
  });
  it("does not start listening when the browser has no speech support", () => {
    const { result } = renderHook(() => useDictation(vi.fn()));
    act(() => result.current.start("en-IN"));
    expect(result.current.supported).toBe(false);
    expect(result.current.listening).toBe(false);
    expect(result.current.error.length).toBeGreaterThan(0);
  });
  it("stops on denied microphone permission without adding text", () => {
    Object.defineProperty(window, "SpeechRecognition", { value: RecognitionStub, configurable: true });
    const append = vi.fn();
    const { result } = renderHook(() => useDictation(append));
    act(() => result.current.start("en-IN"));
    act(() => RecognitionStub.current?.onerror?.({ error: "not-allowed" }));
    expect(result.current.listening).toBe(false);
    expect(append).not.toHaveBeenCalled();
    expect(result.current.error.length).toBeGreaterThan(0);
  });
});