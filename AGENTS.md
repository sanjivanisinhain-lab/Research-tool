<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Keep all research reads and mutations behind the typed `src/api` client; only the mock implementation imports fixtures so a future HTTP backend can replace it.
- Keep deterministic persona response selection in `src/api/personaReplies.ts`; it uses supplied research patterns, never AI or web calls.
- Use the shared API-backed PersonaChips control across audience-selection views so persona labels do not diverge.
- Source context is returned with evidence through the typed API, not fabricated in presentation components.
- Confidence scores and factors remain illustrative fixture inputs until a validated method exists; never claim a weighting calculation.
- CX playback uses API-supplied synthetic audio assets and timed transcript cues through a shared player; no original call recording or transcription backend is implied.
- Question dictation uses a browser-only speech recognition hook with explicit permission and service disclosure; pasted transcript attachments stay user material, outside repository evidence.
