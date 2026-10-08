import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { AppError, modelConfigSchema, defaultProviderBaseUrl } from '@lodex/contracts';
import { runModelEvaluation } from '../apps/daemon/src/model-evaluation.ts';

const help = `Lodex model evaluation (synthetic fixtures only)

npm run evaluate -- --provider ollama --model qwen3:8b
npm run evaluate -- --provider vllm --model local-model --base-url http://localhost:8000/v1 --suite context
npm run evaluate -- --provider openrouter --model vendor/model --allow-cloud --max-cost-usd 1
npm run evaluate -- --provider llama-server --model local --soak-hours 8 --suite context

Options:
  --provider                 llama-server | ollama | vllm | mlx | openrouter (required)
  --model                    Exact installed/catalog model ID (required)
  --base-url                 Local server URL; provider default if omitted
  --variant                  both | baseline | eco (default both)
  --suite                    smoke | context (default smoke)
  --rounds                   Repetitions per variant (default 1)
  --soak-hours               Repeat until duration, up to 72 hours
  --request-timeout-seconds   Each inference timeout (default 120)
  --turn-timeout-seconds      Each task timeout (default 600)
  --total-timeout-seconds     Whole run (default 1800, or soak duration + two task timeouts)
  --max-calls-per-turn        Model call cap per task (default 100)
  --max-cost-usd              Whole-run reservation budget (default 0)
  --allow-cloud              Explicitly allow synthetic fixture transmission and paid calls
  --context-tokens           App context budget (default 32768)
  --output-tokens            Output budget (default 20% of context)
  --output-directory         JSON reports (default .local/evaluations, ignored by git)
  --model-file               Optional local model SHA-256, no execution
  --engine-file              Optional engine SHA-256, no execution
  --engine-version           User-reported engine version in the report

OpenRouter key: OPENROUTER_API_KEY from environment or the repository .env.
No host/Docker commands, web tools, browser, MCP, or subagents are permitted.
Ctrl+C cancels active inference, saves measured results and removes isolated fixtures.
Reports cover this exact run. They do not certify arbitrary models or an 8-hour run
that was not actually completed. Missing server metrics remain unmeasured.
`;

export async function main(args = process.argv.slice(2)) {
  const valueNames = [
    'provider',
    'model',
    'base-url',
    'variant',
    'suite',
    'rounds',
    'soak-hours',
    'request-timeout-seconds',
    'turn-timeout-seconds',
    'total-timeout-seconds',
    'max-calls-per-turn',
    'max-cost-usd',
    'context-tokens',
    'output-tokens',
    'output-directory',
    'model-file',
    'engine-file',
    'engine-version',
  ];
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      ...Object.fromEntries(valueNames.map((name) => [name, { type: 'string' }])),
      'allow-cloud': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(help);
    return;
  }
  if (!values.provider || !values.model)
    throw new Error('--provider and --model are required. Use --help.');
  const numeric = (name, fallback) =>
    values[name] === undefined ? fallback : Number(values[name]);
  const context = numeric('context-tokens', 32768),
    soak = numeric('soak-hours', undefined);
  const config = modelConfigSchema.parse({
    provider: values.provider,
    model: values.model,
    baseUrl: values['base-url'] ?? defaultProviderBaseUrl(values.provider),
    contextBudgetTokens: context,
    maxTokens: numeric('output-tokens', Math.floor(context * 0.2)),
    autoMaxTokens: values['output-tokens'] === undefined,
  });
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('User cancelled model evaluation'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    // Load keys only after command-line validation; never print or put them in reports.
    if (config.provider === 'openrouter' && values['allow-cloud'] && existsSync(resolve('.env')))
      process.loadEnvFile(resolve('.env'));
    const result = await runModelEvaluation(
      {
        config,
        variant: values.variant ?? 'both',
        suite: values.suite ?? 'smoke',
        rounds: numeric('rounds', 1),
        ...(soak === undefined ? {} : { soakHours: soak }),
        requestTimeoutMs: numeric('request-timeout-seconds', 120) * 1000,
        turnTimeoutMs: numeric('turn-timeout-seconds', 600) * 1000,
        totalTimeoutMs:
          numeric(
            'total-timeout-seconds',
            soak === undefined ? 1800 : soak * 3600 + numeric('turn-timeout-seconds', 600) * 2,
          ) * 1000,
        maxCallsPerTurn: numeric('max-calls-per-turn', 100),
        maxCostUsd: numeric('max-cost-usd', 0),
        allowCloud: values['allow-cloud'],
        outputDirectory: resolve(values['output-directory'] ?? '.local/evaluations'),
        ...(values['model-file'] ? { modelFile: resolve(values['model-file']) } : {}),
        ...(values['engine-file'] ? { engineFile: resolve(values['engine-file']) } : {}),
        ...(values['engine-version'] ? { engineVersion: values['engine-version'] } : {}),
      },
      {
        signal: controller.signal,
        ...(config.provider === 'openrouter' && process.env.OPENROUTER_API_KEY
          ? { apiKey: process.env.OPENROUTER_API_KEY }
          : {}),
        onProgress: (item) =>
          process.stdout.write(
            JSON.stringify({
              round: item.round,
              variant: item.variant,
              task: item.task,
              passed: item.passed,
              durationMs: Math.round(item.durationMs),
              reasons: item.reasons,
            }) + '\n',
          ),
      },
    );
    process.stdout.write(
      JSON.stringify(
        {
          report: resolve(values['output-directory'] ?? '.local/evaluations', result.id + '.json'),
          stopped: result.stopped,
          summary: result.summary,
        },
        null,
        2,
      ) + '\n',
    );
    if (
      !result.cases.length ||
      result.cases.some((item) => !item.passed) ||
      ['error', 'cost_budget', 'cancelled'].includes(result.stopped)
    )
      process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    process.stderr.write(
      error instanceof AppError
        ? error.message + '\n'
        : 'Model evaluation failed before a report could be saved. Check arguments, model connection and output path. Use --help.\n',
    );
    process.exitCode = 1;
  });
