# Media Processor

- NarratoAI integration in `media-processor` uses existing StoryScript + `story_narration_assets` artifacts instead of adding Project/Draft narration columns.
- Documentary mode uses asset `frame_analysis_json` / `frame_analysis_status` / `frame_analysis_error` and `frame_analysis_service.py` to build visual summaries before StoryScript generation; frame analysis must use OpenCode provider/model settings first, with Gemini key pool only as fallback.
- `documentary` and `drama_explain` are draft-scoped `edit_mode` values that must be accepted by API schemas, preserved in draft summaries/re-render flags, and exposed in ProjectEdit.
- TTS remains optional via `story_narration` render flag plus Settings UI / DB-backed `story_tts_provider`, `story_tts_voice`, `story_tts_model`, and `story_tts_timeout_s` settings with env fallback; if unavailable, subtitle-only Story/Narrato render should remain usable.
- `edge-tts` is a runtime dependency when `story_tts_provider=edge` is used.
- Story/Narrato Edge TTS writes a same-stem `.srt` sidecar beside the narration audio and render-time subtitles should prefer those WordBoundary timings over equal-duration page splits; displayed Story/Narrato subtitles strip punctuation while TTS narration text keeps punctuation for natural speech.
- Production editing workers may expose `h264_nvenc` in `ffmpeg -encoders` while lacking CUDA runtime (`libcuda.so.1`); renderer encoder selection must smoke-test actual encode initialization and fall back to `libx264`. Project 3 documentary subtitle-only smoke passed after this fix on draft 59 / version 26.
