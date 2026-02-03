# Feedback Quality Assurance MVP

Local MVP that checks feedback quality against a rubric and provides human-in-the-loop suggestions.

## Quick start

1. Install dependencies:

```bash
npm install
```

## OpenAI setup

Set `OPENAI_API_KEY` to enable AI-assisted feedback analysis. If local-only mode is checked in the UI, the app will skip the API call and use the heuristic fallback.

```bash
export OPENAI_API_KEY="your_key_here"
```

2. Run the server:

```bash
npm start
```

3. Open the app:

Visit `http://localhost:3000` in a browser.

The backend is currently pinned to `gpt-5-mini` for consistent performance. If you want to change it, update `server/openai.js`.

## Notes

- Uploaded files are processed in memory only (no raw files stored).
- Audit logs store hashes, timestamps, and acceptance counts in `data/audit_log.jsonl`.
- The analysis uses AI to build rubric categories/subcriteria, map draft feedback to them, and generate evidence-backed feedback that is ready to paste. Local-only mode uses a lightweight heuristic fallback.
