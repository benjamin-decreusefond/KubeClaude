#!/usr/bin/env node
// Stands in for the Claude CLI so the queue, runner and auto-resume paths can be
// tested without network access or a real token.
import fs from 'node:fs';

// `claude --version` exits without reading stdin; mirror that so the probe works.
if (process.argv.includes('--version')) {
  process.stdout.write('9.9.9 (fake-claude)\n');
  process.exit(0);
}

const mode = process.env.FAKE_CLAUDE_MODE ?? 'success';
const sessionId = process.env.FAKE_SESSION_ID ?? 'session-abc';
const recordTo = process.env.FAKE_CLAUDE_RECORD;

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdin += chunk;
});
process.stdin.on('end', () => {
  if (recordTo) {
    fs.appendFileSync(recordTo, `${JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd() })}\n`);
  }

  const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  emit({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-sonnet-5', tools: ['Bash'] });

  // FAKE_CLAUDE_MARKER simulates the model announcing that it finished.
  const marker = process.env.FAKE_CLAUDE_MARKER;
  const text = marker ? `all done here\n${marker}` : 'working on it';
  emit({
    type: 'assistant',
    session_id: sessionId,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });

  const usage = {
    input_tokens: 1000,
    output_tokens: 500,
    cache_creation_input_tokens: 200,
    cache_read_input_tokens: 300,
    service_tier: 'standard',
  };

  if (mode === 'ratelimit') {
    const resetAt = Number(process.env.FAKE_RESET_EPOCH ?? Math.floor(Date.now() / 1000) + 3600);
    emit({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      session_id: sessionId,
      result: `Claude AI usage limit reached|${resetAt}`,
      num_turns: 2,
      duration_api_ms: 1200,
      total_cost_usd: 0.02,
      usage,
    });
    process.exit(0);
  }

  if (mode === 'failure') {
    emit({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      session_id: sessionId,
      result: 'Something went wrong in the tool call',
      num_turns: 1,
      total_cost_usd: 0.01,
      usage,
    });
    process.exit(0);
  }

  if (mode === 'hang') {
    // Never emits a result; used to exercise the timeout path.
    setInterval(() => {}, 1000);
    return;
  }

  if (mode === 'burn') {
    // Spends steadily and never finishes, so only the token ceiling can stop it.
    // Each turn reports its own usage, which is how a real run streams cost.
    const perTurn = Number(process.env.FAKE_BURN_PER_TURN ?? 10_000);
    const timer = setInterval(() => {
      emit({
        type: 'assistant',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'still going' }],
          usage: { input_tokens: perTurn, output_tokens: 0, cache_read_input_tokens: 0 },
        },
      });
    }, 20);
    process.on('SIGTERM', () => {
      clearInterval(timer);
      process.exit(0);
    });
    return;
  }

  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: sessionId,
    // FAKE_CLAUDE_RESULT stands in for a model that answers in a fixed shape,
    // such as the report a goal iteration has to end with.
    result: process.env.FAKE_CLAUDE_RESULT ?? `done: ${stdin.trim().slice(0, 60)}`,
    num_turns: 3,
    duration_ms: 4200,
    duration_api_ms: 3100,
    total_cost_usd: 0.05,
    usage,
    modelUsage: {
      'claude-sonnet-5': {
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationInputTokens: 200,
        cacheReadInputTokens: 300,
        costUSD: 0.05,
      },
    },
  });
  process.exit(0);
});
