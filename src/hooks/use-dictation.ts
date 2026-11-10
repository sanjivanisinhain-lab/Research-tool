import { useEffect, useRef, useState } from "react";

type Result = { isFinal: boolean; 0: { transcript: string } };
type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<Result> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null; start: () => void; stop: () => void; abort: () => void;
};
type SpeechWindow = Window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };

export function useDictation(onText: (text: string) => void) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState("");
  const ref = useRef<Recognition | null>(null);
  const callback = useRef(onText);
  callback.current = onText;
  useEffect(() => {
    const w = window as SpeechWindow;
    setSupported(Boolean(w.SpeechRecognition ?? w.webkitSpeechRecognition));
    return () => { const r = ref.current; if (r) { r.onend = null; r.onresult = null; r.onerror = null; r.abort(); } };
  }, []);
  const start = (lang: string) => {
    const w = window as SpeechWindow;
    const Constructor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Constructor) { setError("Voice input is unavailable in this browser. Type or paste your question instead."); return; }
    const r = new Constructor();
    ref.current = r;
    r.lang = lang; r.continuous = true; r.interimResults = true;
    r.onresult = (event) => {
      let pending = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result) continue;
        if (result.isFinal) callback.current(result[0].transcript);
        else pending += result[0].transcript;
      }
      setInterim(pending);
    };
    r.onerror = (event) => { setError(event.error === "not-allowed" ? "Microphone permission was denied. You can still type or paste." : "Voice input stopped. Please try again or type your question."); setListening(false); setInterim(""); };
    r.onend = () => { setListening(false); setInterim(""); };
    try { r.start(); setListening(true); setError(""); } catch { setError("Couldn't start the microphone. Please try again."); }
  };
  return { supported, listening, interim, error, start, stop: () => ref.current?.stop() };
}