#!/usr/bin/env bash
set -euo pipefail

# Drives the Handoff Gate API for the live demo. Start the application first,
# then supply the three pre-created Agent ids:
#
# RESEARCHER_AGENT_ID=... SUMMARIZER_AGENT_ID=... FORMATTER_AGENT_ID=... \
#   ./scripts/demo-pipeline.sh
#
# Optional: BASE_URL=http://localhost:3000 APP_AUTH_TOKEN=... POLL_INTERVAL=2

base_url="${BASE_URL:-http://localhost:3000}"
poll_interval="${POLL_INTERVAL:-2}"
researcher_id="${RESEARCHER_AGENT_ID:?Set RESEARCHER_AGENT_ID to the Researcher Agent UUID.}"
summarizer_id="${SUMMARIZER_AGENT_ID:?Set SUMMARIZER_AGENT_ID to the Summarizer Agent UUID.}"
formatter_id="${FORMATTER_AGENT_ID:?Set FORMATTER_AGENT_ID to the Formatter Agent UUID.}"

headers=(-H "content-type: application/json")
if [[ -n "${APP_AUTH_TOKEN:-}" ]]; then
  headers+=(-H "authorization: Bearer ${APP_AUTH_TOKEN}")
fi

api() {
  curl --silent --show-error --fail-with-body "${headers[@]}" "$@"
}

payload="$({
  RESEARCHER_AGENT_ID="$researcher_id" \
    SUMMARIZER_AGENT_ID="$summarizer_id" \
    FORMATTER_AGENT_ID="$formatter_id" \
    node -e '
      console.log(JSON.stringify({
        title: "Battery recycling provenance demo",
        topic: "What can be recovered from lithium-ion batteries?",
        sources: [
          {
            name: "recycling-notes.md",
            content: "# Recycling notes\\nLithium-ion battery recycling can recover lithium and nickel.",
          },
          {
            name: "safety-notes.md",
            content: "# Safety notes\\nRecovering materials requires controlled processing.",
          },
          {
            name: "market-notes.md",
            content: "# Market notes\\nRecycled materials can reduce demand for virgin extraction.",
          },
        ],
        stages: [
          {
            id: "research",
            role: "Researcher",
            agentId: process.env.RESEARCHER_AGENT_ID,
            schemaId: "research",
            outputPath: "research.json",
            inputFileName: null,
            instruction: "Extract sourced claims from the seeded documents.",
          },
          {
            id: "summary",
            role: "Summarizer",
            agentId: process.env.SUMMARIZER_AGENT_ID,
            schemaId: "summary",
            outputPath: "summary.json",
            inputFileName: "research.json",
            instruction: "Write cited key points using only the supplied claims.",
          },
          {
            id: "report",
            role: "Formatter",
            agentId: process.env.FORMATTER_AGENT_ID,
            schemaId: "report",
            outputPath: "report.md",
            inputFileName: "summary.json",
            instruction: "Format the cited key points as a concise Markdown report.",
          },
        ],
      }));
    '
})"

echo "Creating pipeline session..."
session_json="$(api -X POST "$base_url/api/sessions" --data "$payload")"
session_id="$(printf '%s' "$session_json" | node -e '
  let raw = "";
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", () => {
    const id = JSON.parse(raw).session?.id;
    if (!id) process.exit(1);
    process.stdout.write(id);
  });
')"

echo "Created session: $session_id"
echo "Starting pipeline..."
api -X POST "$base_url/api/sessions/$session_id/start" --data '{}' >/dev/null

last_seq=0
for ((attempt = 1; attempt <= 60; attempt += 1)); do
  events_json="$(api "$base_url/api/sessions/$session_id/events?after=$last_seq")"
  printf '%s\n' "$events_json"

  last_seq="$(printf '%s' "$events_json" | node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      const events = JSON.parse(raw).events ?? [];
      process.stdout.write(String(events.reduce((max, event) => Math.max(max, event.seq), 0)));
    });
  ')"

  session_state="$(api "$base_url/api/sessions/$session_id" | node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => process.stdout.write(JSON.parse(raw).session.state));
  ')"
  echo "Session state: $session_state"
  if [[ "$session_state" == "completed" || "$session_state" == "failed" || "$session_state" == "stopped" ]]; then
    break
  fi

  sleep "$poll_interval"
done

echo "Final session:"
api "$base_url/api/sessions/$session_id"
