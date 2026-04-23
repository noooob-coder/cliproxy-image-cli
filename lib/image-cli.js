"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { Buffer } = require("node:buffer");

const DEFAULT_MODEL = "gpt-image-2";
const DEFAULT_RESPONSES_MODEL = "gpt-5.4-mini";
const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_SIZE = "1024x1024";
const DEFAULT_RESPONSE_FORMAT = "b64_json";
const DEFAULT_OUTPUT_FORMAT = "png";
const DEFAULT_CODEX_HOME = path.join(os.homedir(), ".codex");
const PREFERENCE_FILE_NAME = "cliproxy-image-cli-preferences.json";
const TRANSPORT_IMAGES = "images";
const TRANSPORT_RESPONSES = "responses";
const ALLOWED_IMAGE_SIZES = new Set(["1024x1024", "1536x1024", "1024x1536", "auto"]);

class CLIError extends Error {}

async function main(argv) {
  const { command, globalOptions, subcommandArgs } = splitCommand(argv);
  if (!command || globalOptions.help) {
    printGlobalHelp();
    return 0;
  }

  const context = parseGlobalOptions(globalOptions);
  let result;
  if (command === "generate") {
    result = await handleGenerate(subcommandArgs, context);
  } else if (command === "edit") {
    result = await handleEdit(subcommandArgs, context);
  } else {
    throw new CLIError(`Unknown command: ${command}`);
  }

  if (result !== null) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  return 0;
}

function splitCommand(argv) {
  const globalArgs = [];
  let command = null;
  let subcommandArgs = [];
  const knownCommands = new Set(["generate", "edit"]);

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!command && knownCommands.has(value)) {
      command = value;
      subcommandArgs = argv.slice(index + 1);
      break;
    }
    globalArgs.push(value);
  }

  const globalOptions = parseArgs({
    args: globalArgs,
    options: {
      help: { type: "boolean", short: "h", default: false },
      timeout: { type: "string" },
      "metadata-path": { type: "string" },
      overwrite: { type: "boolean", default: false }
    },
    allowPositionals: true,
    strict: true
  }).values;

  return { command, globalOptions, subcommandArgs };
}

function parseGlobalOptions(values) {
  const timeoutRaw = values.timeout ?? process.env.CLIPROXY_TIMEOUT_SECONDS ?? `${DEFAULT_TIMEOUT_SECONDS}`;
  const timeout = Number.parseInt(timeoutRaw, 10);
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new CLIError("--timeout must be a positive integer.");
  }

  const credentials = discoverRuntimeCredentials();
  return {
    timeout,
    metadataPath: values["metadata-path"] ?? "",
    overwrite: Boolean(values.overwrite),
    ...credentials
  };
}

async function handleGenerate(argv, context) {
  const parsed = parseArgs({
    args: argv,
    options: commandOptions(),
    allowPositionals: true,
    strict: true
  });
  if (parsed.values.help) {
    printGenerateHelp();
    return null;
  }

  const prompt = readPrompt(parsed.positionals[0], parsed.values["prompt-file"]);
  const payload = {
    model: parsed.values.model ?? DEFAULT_MODEL,
    prompt,
    size: normalizeSize(parsed.values.size),
    response_format: parsed.values["response-format"] ?? DEFAULT_RESPONSE_FORMAT,
    output_format: normalizeOutputFormat(parsed.values["output-format"] ?? DEFAULT_OUTPUT_FORMAT)
  };
  assignOptionalFields(payload, {
    quality: parsed.values.quality,
    background: parsed.values.background,
    moderation: parsed.values.moderation,
    partial_images: parseOptionalInteger(parsed.values["partial-images"], "--partial-images")
  });

  const response = await requestImageOperation(context, "generate", payload);
  return finalizeResponse({
    response,
    outputValue: parsed.values.output,
    outputHint: payload.output_format,
    metadataPath: context.metadataPath,
    overwrite: context.overwrite,
    command: "generate",
    prompt
  });
}

async function handleEdit(argv, context) {
  const parsed = parseArgs({
    args: argv,
    options: {
      ...commandOptions(),
      image: { type: "string", multiple: true },
      mask: { type: "string" },
      "input-fidelity": { type: "string" }
    },
    allowPositionals: true,
    strict: true
  });
  if (parsed.values.help) {
    printEditHelp();
    return null;
  }

  const prompt = readPrompt(parsed.positionals[0], parsed.values["prompt-file"]);
  const imageInputs = parsed.values.image ?? [];
  if (imageInputs.length === 0) {
    throw new CLIError("At least one --image value is required.");
  }
  const payload = {
    model: parsed.values.model ?? DEFAULT_MODEL,
    prompt,
    images: imageInputs.map((value) => ({ image_url: sourceToImageReference(value) })),
    size: normalizeSize(parsed.values.size),
    response_format: parsed.values["response-format"] ?? DEFAULT_RESPONSE_FORMAT,
    output_format: normalizeOutputFormat(parsed.values["output-format"] ?? DEFAULT_OUTPUT_FORMAT)
  };
  assignOptionalFields(payload, {
    quality: parsed.values.quality,
    background: parsed.values.background,
    moderation: parsed.values.moderation,
    input_fidelity: parsed.values["input-fidelity"],
    partial_images: parseOptionalInteger(parsed.values["partial-images"], "--partial-images")
  });
  if (parsed.values.mask) {
    payload.mask = { image_url: sourceToImageReference(parsed.values.mask) };
  }

  const response = await requestImageOperation(context, "edit", payload);
  return finalizeResponse({
    response,
    outputValue: parsed.values.output,
    outputHint: payload.output_format,
    metadataPath: context.metadataPath,
    overwrite: context.overwrite,
    command: "edit",
    prompt
  });
}

function commandOptions() {
  return {
    help: { type: "boolean", short: "h", default: false },
    model: { type: "string", default: DEFAULT_MODEL },
    output: { type: "string" },
    "prompt-file": { type: "string" },
    size: { type: "string", default: DEFAULT_SIZE },
    quality: { type: "string" },
    background: { type: "string" },
    moderation: { type: "string" },
    "partial-images": { type: "string" },
    "output-format": { type: "string", default: DEFAULT_OUTPUT_FORMAT },
    "response-format": { type: "string", default: DEFAULT_RESPONSE_FORMAT }
  };
}

function normalizeSize(value) {
  const normalized = String(value || DEFAULT_SIZE).trim().toLowerCase();
  if (!ALLOWED_IMAGE_SIZES.has(normalized)) {
    throw new CLIError("size must be one of: 1024x1024, 1536x1024, 1024x1536, or auto.");
  }
  return normalized;
}

function discoverRuntimeCredentials() {
  const codexHome = resolveCodexHome();
  const configPath = path.join(codexHome, "config.toml");
  const authPath = path.join(codexHome, "auth.json");

  const config = loadCodexConfig(configPath);
  const baseUrl = discoverBaseUrl(config);
  const apiKey = discoverApiKey(authPath);

  if (!baseUrl) {
    throw new CLIError(
      `Unable to discover a Codex OpenAI-compatible base URL from ${configPath}. ` +
        "Configure Codex with a model provider that exposes an OpenAI-compatible base_url."
    );
  }
  if (!apiKey) {
    throw new CLIError(
      `Unable to discover an OpenAI API key from ${authPath}. ` +
        "Make sure Codex is logged in or has a stored OPENAI_API_KEY."
    );
  }

  return {
    baseUrl,
    apiKey,
    codexHome,
    codexConfigPath: configPath,
    codexAuthPath: authPath
  };
}

function resolveCodexHome() {
  const candidates = [];
  if (process.env.CODEX_HOME && process.env.CODEX_HOME.trim()) {
    candidates.push(path.resolve(process.env.CODEX_HOME.trim()));
  }
  candidates.push(DEFAULT_CODEX_HOME);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }
  return candidates[0];
}

function loadCodexConfig(configPath) {
  if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
    return { topLevel: {}, tables: {} };
  }
  const raw = fs.readFileSync(configPath, "utf8");
  return parseSimpleToml(raw);
}

function parseSimpleToml(raw) {
  const topLevel = {};
  const tables = {};
  let currentTable = null;

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) {
      continue;
    }

    const tableMatch = line.match(/^\[(.+)\]$/);
    if (tableMatch) {
      currentTable = tableMatch[1].trim();
      if (!tables[currentTable]) {
        tables[currentTable] = {};
      }
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = parseTomlValue(line.slice(separatorIndex + 1).trim());

    if (currentTable) {
      tables[currentTable][key] = value;
    } else {
      topLevel[key] = value;
    }
  }

  return { topLevel, tables };
}

function stripTomlComment(line) {
  let inString = false;
  let escaped = false;
  let result = "";

  for (const character of line) {
    if (character === '"' && !escaped) {
      inString = !inString;
    }
    if (character === "#" && !inString) {
      break;
    }
    result += character;
    escaped = character === "\\" && !escaped;
    if (character !== "\\") {
      escaped = false;
    }
  }

  return result;
}

function parseTomlValue(rawValue) {
  if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
    return rawValue.slice(1, -1).replace(/\\"/g, '"');
  }
  if (rawValue === "true") {
    return true;
  }
  if (rawValue === "false") {
    return false;
  }
  if (/^-?\d+$/.test(rawValue)) {
    return Number.parseInt(rawValue, 10);
  }
  return rawValue;
}

function discoverBaseUrl(config) {
  const envBaseUrl = firstNonEmptyString(process.env.OPENAI_BASE_URL, process.env.CLIPROXY_BASE_URL);
  if (envBaseUrl) {
    return normalizeBaseUrl(envBaseUrl);
  }

  const providerName = String(config.topLevel.model_provider || "").trim();
  if (providerName) {
    const providerTable = config.tables[`model_providers.${providerName}`];
    const providerBaseUrl = providerTable && firstNonEmptyString(providerTable.base_url);
    if (providerBaseUrl) {
      return normalizeBaseUrl(providerBaseUrl);
    }
  }

  const preferredTables = Object.entries(config.tables)
    .filter(([tableName, values]) => tableName.startsWith("model_providers.") && values && values.base_url)
    .sort(([left], [right]) => left.localeCompare(right));

  for (const [, values] of preferredTables) {
    const value = firstNonEmptyString(values.base_url);
    if (value) {
      return normalizeBaseUrl(value);
    }
  }

  return "";
}

function discoverApiKey(authPath) {
  const envApiKey = firstNonEmptyString(process.env.OPENAI_API_KEY, process.env.CLIPROXY_API_KEY);
  if (envApiKey) {
    return envApiKey;
  }

  if (!fs.existsSync(authPath) || !fs.statSync(authPath).isFile()) {
    return "";
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(authPath, "utf8"));
  } catch {
    return "";
  }

  if (!parsed || typeof parsed !== "object") {
    return "";
  }

  return firstNonEmptyString(
    parsed.OPENAI_API_KEY,
    parsed.OPENAI_API_TOKEN,
    parsed.api_key,
    parsed.token,
    parsed.openai_api_key
  );
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function normalizeBaseUrl(value) {
  return String(value).trim().replace(/\/+$/, "");
}

function buildApiUrl(baseUrl, routePath) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const normalizedRoute = String(routePath).replace(/^\/+/, "");
  if (normalizedBaseUrl.endsWith("/v1")) {
    return `${normalizedBaseUrl}/${normalizedRoute}`;
  }
  return `${normalizedBaseUrl}/v1/${normalizedRoute}`;
}

function readPrompt(promptArgument, promptFile) {
  if (promptArgument && promptFile) {
    throw new CLIError("Provide either an inline prompt or --prompt-file, not both.");
  }

  let prompt = promptArgument ?? "";
  if (promptFile) {
    const filePath = path.resolve(promptFile);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new CLIError(`Prompt file not found: ${filePath}`);
    }
    prompt = fs.readFileSync(filePath, "utf8");
  }

  prompt = prompt.trim();
  if (!prompt) {
    throw new CLIError("Prompt is required.");
  }
  return prompt;
}

function parseOptionalInteger(rawValue, flagName) {
  if (rawValue === undefined) {
    return undefined;
  }
  const value = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new CLIError(`${flagName} must be a non-negative integer.`);
  }
  return value;
}

function assignOptionalFields(payload, values) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "string" && value.trim() === "") {
      continue;
    }
    payload[key] = typeof value === "string" ? value.trim() : value;
  }
}

function normalizeOutputFormat(value) {
  const lowered = String(value).trim().toLowerCase();
  return lowered === "jpg" ? "jpeg" : lowered;
}

function sourceToImageReference(value) {
  const raw = String(value).trim();
  if (!raw) {
    throw new CLIError("Image input must not be empty.");
  }

  if (raw.startsWith("data:")) {
    return raw;
  }

  try {
    const url = new URL(raw);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return raw;
    }
  } catch {
    // ignore and treat as a filesystem path
  }

  const filePath = path.resolve(raw);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new CLIError(`Image file not found: ${filePath}`);
  }
  const data = fs.readFileSync(filePath);
  if (data.length === 0) {
    throw new CLIError(`Image file is empty: ${filePath}`);
  }

  const mediaType = guessMediaType(filePath, data);
  return `data:${mediaType};base64,${data.toString("base64")}`;
}

function guessMediaType(filePath, data) {
  const extension = path.extname(filePath).toLowerCase();
  const byExtension = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif"
  };
  if (byExtension[extension]) {
    return byExtension[extension];
  }

  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return "image/jpeg";
  }
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a") {
    return "image/gif";
  }
  return "application/octet-stream";
}

async function postJson(context, routePath, payload) {
  const url = buildApiUrl(context.baseUrl, routePath);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${context.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(context.timeout * 1000)
  }).catch((error) => {
    throw new CLIError(`Failed to connect to the Codex OpenAI endpoint at ${context.baseUrl}: ${error.message}`);
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CLIError("Server returned a non-JSON response.");
  }

  if (!response.ok) {
    const message = extractErrorMessage(parsed) || response.statusText;
    if (isUnsupportedImageCapabilityError(response.status, routePath, message)) {
      const error = new CLIError(formatUnsupportedImageCapabilityError({
        context,
        routePath,
        url,
        payload,
        upstreamMessage: message
      }));
      error.statusCode = response.status;
      error.routePath = routePath;
      error.upstreamMessage = message;
      error.baseUrl = context.baseUrl;
      error.isImageCapabilityError = true;
      throw error;
    }
    const error = new CLIError(`HTTP ${response.status}: ${message}`);
    error.statusCode = response.status;
    error.routePath = routePath;
    error.upstreamMessage = message;
    throw error;
  }
  return parsed;
}

async function requestImageOperation(context, action, payload) {
  const routePath = action === "edit" ? "images/edits" : "images/generations";
  const preferredTransport = loadPreferredTransport(context, action);

  if (preferredTransport === TRANSPORT_RESPONSES) {
    try {
      const response = await postImagesViaResponses(context, action, payload);
      persistPreferredTransport(context, action, TRANSPORT_RESPONSES);
      return response;
    } catch (responsesError) {
      try {
        const response = await postJson(context, routePath, payload);
        persistPreferredTransport(context, action, TRANSPORT_IMAGES);
        return response;
      } catch (directError) {
        throw createPreferredTransportFailureError({
          context,
          action,
          payload,
          preferredTransport,
          preferredError: responsesError,
          alternateRoutePath: routePath,
          alternateError: directError
        });
      }
    }
  }

  try {
    const response = await postJson(context, routePath, payload);
    persistPreferredTransport(context, action, TRANSPORT_IMAGES);
    return response;
  } catch (error) {
    if (!shouldRetryViaResponsesFallback(error, routePath)) {
      throw error;
    }

    try {
      const response = await postImagesViaResponses(context, action, payload);
      persistPreferredTransport(context, action, TRANSPORT_RESPONSES);
      return response;
    } catch (fallbackError) {
      throw createFallbackFailureError(context, routePath, payload, error, fallbackError);
    }
  }
}

function shouldRetryViaResponsesFallback(error, routePath) {
  if (!(error instanceof CLIError) || !String(routePath).startsWith("images/")) {
    return false;
  }

  if (error.isImageCapabilityError) {
    return true;
  }

  const message = String(error.upstreamMessage || error.message || "").toLowerCase();
  return message.includes("upstream did not return image output");
}

function loadPreferredTransport(context, action) {
  const preferences = readTransportPreferences(context && context.codexHome);
  const key = transportPreferenceKey(context, action);
  const value = preferences[key];
  if (value === TRANSPORT_IMAGES || value === TRANSPORT_RESPONSES) {
    return value;
  }
  return "";
}

function persistPreferredTransport(context, action, transport) {
  if (transport !== TRANSPORT_IMAGES && transport !== TRANSPORT_RESPONSES) {
    return;
  }

  const filePath = preferenceFilePath(context && context.codexHome);
  const preferences = readTransportPreferences(context && context.codexHome);
  preferences[transportPreferenceKey(context, action)] = transport;

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
  } catch {
    // Best-effort cache only; request execution should not fail if preference persistence is unavailable.
  }
}

function readTransportPreferences(codexHome) {
  const filePath = preferenceFilePath(codexHome);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return {};
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

function preferenceFilePath(codexHome) {
  const root = firstNonEmptyString(codexHome) || resolveCodexHome();
  return path.join(root, PREFERENCE_FILE_NAME);
}

function transportPreferenceKey(context, action) {
  const baseUrl = normalizeBaseUrl(context && context.baseUrl ? context.baseUrl : "");
  return `${baseUrl}::${String(action || "").trim().toLowerCase()}`;
}

async function postImagesViaResponses(context, action, payload) {
  const routePath = "responses";
  const url = buildApiUrl(context.baseUrl, routePath);
  const requestPayload = buildResponsesImageRequest(action, payload);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${context.apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json"
    },
    body: JSON.stringify(requestPayload),
    signal: AbortSignal.timeout(context.timeout * 1000)
  }).catch((error) => {
    throw new CLIError(`Failed to connect to the Codex OpenAI endpoint at ${context.baseUrl}: ${error.message}`);
  });

  const text = await response.text();
  if (!response.ok) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    const message = extractErrorMessage(parsed) || response.statusText || "Responses fallback request failed.";
    const error = new CLIError(`HTTP ${response.status}: ${message}`);
    error.statusCode = response.status;
    error.routePath = routePath;
    error.upstreamMessage = message;
    throw error;
  }

  return parseResponsesImageResponse(text, payload.response_format || DEFAULT_RESPONSE_FORMAT);
}

function buildResponsesImageRequest(action, payload) {
  const tool = {
    type: "image_generation",
    action,
    model: payload.model || DEFAULT_MODEL
  };

  assignOptionalFields(tool, {
    size: payload.size,
    quality: payload.quality,
    background: payload.background,
    output_format: payload.output_format,
    moderation: payload.moderation,
    input_fidelity: payload.input_fidelity
  });

  if (payload.partial_images !== undefined) {
    tool.partial_images = payload.partial_images;
  }

  const images = Array.isArray(payload.images) ? payload.images : [];
  const content = [{ type: "input_text", text: payload.prompt || "" }];
  for (const image of images) {
    const imageUrl = image && typeof image.image_url === "string" ? image.image_url.trim() : "";
    if (!imageUrl) {
      continue;
    }
    content.push({ type: "input_image", image_url: imageUrl });
  }

  if (payload.mask && typeof payload.mask.image_url === "string" && payload.mask.image_url.trim()) {
    tool.input_image_mask = { image_url: payload.mask.image_url.trim() };
  }

  return {
    instructions: "",
    stream: true,
    reasoning: { effort: "medium", summary: "auto" },
    parallel_tool_calls: true,
    include: ["reasoning.encrypted_content"],
    model: DEFAULT_RESPONSES_MODEL,
    store: false,
    tool_choice: { type: "image_generation" },
    input: [
      {
        type: "message",
        role: "user",
        content
      }
    ],
    tools: [tool]
  };
}

function parseResponsesImageResponse(rawText, responseFormat) {
  const payloads = parseResponsesPayloads(rawText);
  const streamedResults = [];
  let createdAt = Math.floor(Date.now() / 1000);
  let usage = null;
  let firstMeta = null;

  for (const payload of payloads) {
    if (!payload || typeof payload !== "object") {
      continue;
    }

    const streamedItem = extractResponsesOutputItemDone(payload);
    if (streamedItem) {
      if (!firstMeta) {
        firstMeta = streamedItem;
      }
      streamedResults.push(streamedItem);
      continue;
    }

    if (payload.type !== "response.completed") {
      continue;
    }

    const response = payload.response && typeof payload.response === "object" ? payload.response : {};
    if (Number.isInteger(response.created_at) && response.created_at > 0) {
      createdAt = response.created_at;
    }
    usage = extractResponsesUsage(response) || usage;

    const completedResults = extractResponsesCompletedImages(response);
    if (completedResults.length > 0) {
      if (!firstMeta) {
        firstMeta = completedResults[0];
      }
      streamedResults.push(...completedResults);
    }
  }

  if (streamedResults.length === 0) {
    throw new CLIError("Responses fallback did not return any image output.");
  }

  return buildImagesApiResponseFromResults(streamedResults, createdAt, usage, firstMeta, responseFormat);
}

function parseResponsesPayloads(rawText) {
  const text = String(rawText || "").trim();
  if (!text) {
    throw new CLIError("Responses fallback returned an empty response.");
  }

  if (text.startsWith("{")) {
    try {
      return [JSON.parse(text)];
    } catch {
      throw new CLIError("Responses fallback returned invalid JSON.");
    }
  }

  const payloads = [];
  const frames = text.split(/\r?\n\r?\n+/);
  for (const frame of frames) {
    const lines = frame.split(/\r?\n/);
    for (const line of lines) {
      if (!line.startsWith("data:")) {
        continue;
      }
      const payloadText = line.slice(5).trim();
      if (!payloadText || payloadText === "[DONE]") {
        continue;
      }
      try {
        payloads.push(JSON.parse(payloadText));
      } catch {
        throw new CLIError("Responses fallback returned invalid SSE JSON.");
      }
    }
  }
  return payloads;
}

function extractResponsesOutputItemDone(payload) {
  if (payload.type !== "response.output_item.done") {
    return null;
  }
  return imageCallResultFromResponsesItem(payload.item);
}

function extractResponsesCompletedImages(response) {
  const output = Array.isArray(response.output) ? response.output : [];
  return output.map((item) => imageCallResultFromResponsesItem(item)).filter(Boolean);
}

function imageCallResultFromResponsesItem(item) {
  if (!item || typeof item !== "object" || item.type !== "image_generation_call") {
    return null;
  }
  const result = typeof item.result === "string" ? item.result.trim() : "";
  if (!result) {
    return null;
  }
  return {
    result,
    revised_prompt: typeof item.revised_prompt === "string" ? item.revised_prompt.trim() : "",
    output_format: typeof item.output_format === "string" ? item.output_format.trim() : "",
    size: typeof item.size === "string" ? item.size.trim() : "",
    background: typeof item.background === "string" ? item.background.trim() : "",
    quality: typeof item.quality === "string" ? item.quality.trim() : ""
  };
}

function extractResponsesUsage(response) {
  if (response.tool_usage && response.tool_usage.image_gen && typeof response.tool_usage.image_gen === "object") {
    return response.tool_usage.image_gen;
  }
  if (response.usage && typeof response.usage === "object") {
    return response.usage;
  }
  return null;
}

function buildImagesApiResponseFromResults(results, createdAt, usage, firstMeta, responseFormat) {
  const normalizedResponseFormat = normalizeResponseFormat(responseFormat || DEFAULT_RESPONSE_FORMAT);
  const response = {
    created: createdAt > 0 ? createdAt : Math.floor(Date.now() / 1000),
    data: []
  };

  for (const item of results) {
    const entry = {};
    if (normalizedResponseFormat === "url") {
      const mediaType = mimeTypeFromOutputFormat(item.output_format);
      entry.url = `data:${mediaType};base64,${item.result}`;
    } else {
      entry.b64_json = item.result;
    }
    if (item.revised_prompt) {
      entry.revised_prompt = item.revised_prompt;
    }
    response.data.push(entry);
  }

  if (firstMeta) {
    if (firstMeta.background) {
      response.background = firstMeta.background;
    }
    if (firstMeta.output_format) {
      response.output_format = firstMeta.output_format;
    }
    if (firstMeta.quality) {
      response.quality = firstMeta.quality;
    }
    if (firstMeta.size) {
      response.size = firstMeta.size;
    }
  }

  if (usage) {
    response.usage = usage;
  }

  return response;
}

function createFallbackFailureError(context, routePath, payload, originalError, fallbackError) {
  const url = buildApiUrl(context.baseUrl, routePath);
  const responsesUrl = buildApiUrl(context.baseUrl, "responses");
  const capability = String(routePath).includes("edits") ? "image editing" : "image generation";
  const model = payload && typeof payload.model === "string" && payload.model.trim() ? payload.model.trim() : DEFAULT_MODEL;
  return new CLIError(
    [
      `The local Codex configuration was discovered successfully, but the current upstream provider still could not complete ${capability}.`,
      `Base URL: ${context.baseUrl}`,
      `Image endpoint: ${url}`,
      `Responses fallback endpoint: ${responsesUrl}`,
      `Model: ${model}`,
      `Image endpoint response: ${originalError.upstreamMessage || originalError.message}`,
      `Responses fallback response: ${fallbackError.upstreamMessage || fallbackError.message}`,
      "Action: point Codex at an OpenAI-compatible provider that implements either /v1/images/* directly or the Responses image-generation tool flow."
    ].join("\n")
  );
}

function createPreferredTransportFailureError({
  context,
  action,
  payload,
  preferredTransport,
  preferredError,
  alternateRoutePath,
  alternateError
}) {
  const capability = action === "edit" ? "image editing" : "image generation";
  const model = payload && typeof payload.model === "string" && payload.model.trim() ? payload.model.trim() : DEFAULT_MODEL;
  const preferredLabel =
    preferredTransport === TRANSPORT_RESPONSES
      ? `Responses fallback endpoint: ${buildApiUrl(context.baseUrl, "responses")}`
      : `Image endpoint: ${buildApiUrl(context.baseUrl, alternateRoutePath)}`;
  const alternateLabel =
    preferredTransport === TRANSPORT_RESPONSES
      ? `Image endpoint: ${buildApiUrl(context.baseUrl, alternateRoutePath)}`
      : `Responses fallback endpoint: ${buildApiUrl(context.baseUrl, "responses")}`;

  return new CLIError(
    [
      `The cached preferred transport for ${capability} could not complete the request, and the alternate transport also failed.`,
      `Base URL: ${context.baseUrl}`,
      `Model: ${model}`,
      preferredLabel,
      `Preferred transport response: ${preferredError.upstreamMessage || preferredError.message}`,
      alternateLabel,
      `Alternate transport response: ${alternateError.upstreamMessage || alternateError.message}`,
      "Action: verify the current upstream still supports image generation or image editing for the local Codex configuration."
    ].join("\n")
  );
}

function isUnsupportedImageCapabilityError(statusCode, routePath, message) {
  if (!String(routePath).startsWith("images/")) {
    return false;
  }

  const normalizedMessage = String(message || "").trim().toLowerCase();
  if (!normalizedMessage) {
    return statusCode === 404 || statusCode === 405 || statusCode === 501;
  }

  const knownSignals = [
    "upstream did not return image output",
    "does not support image",
    "doesn't support image",
    "not support image",
    "image generation is not supported",
    "image editing is not supported",
    "only supported on /v1/images/",
    "/v1/images/generations",
    "/v1/images/edits"
  ];

  if (knownSignals.some((signal) => normalizedMessage.includes(signal))) {
    return true;
  }

  return normalizedMessage.includes("not found") && (statusCode === 404 || statusCode === 405 || statusCode === 501);
}

function formatUnsupportedImageCapabilityError({ context, routePath, url, payload, upstreamMessage }) {
  const capability = String(routePath).includes("edits") ? "image editing" : "image generation";
  const model = payload && typeof payload.model === "string" && payload.model.trim() ? payload.model.trim() : DEFAULT_MODEL;

  return [
    `The local Codex configuration was discovered successfully, but the current upstream provider does not support ${capability}.`,
    `Base URL: ${context.baseUrl}`,
    `Endpoint: ${url}`,
    `Model: ${model}`,
    `Upstream response: ${upstreamMessage}`,
    "Action: point Codex at an OpenAI-compatible provider that implements the image endpoints."
  ].join("\n");
}

function extractErrorMessage(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return "";
  }
  if (parsed.error && typeof parsed.error === "object" && typeof parsed.error.message === "string") {
    return parsed.error.message.trim();
  }
  if (typeof parsed.message === "string") {
    return parsed.message.trim();
  }
  return "";
}

function decodeImagesFromResponse(response, outputHint) {
  const items = response && response.data;
  if (!Array.isArray(items) || items.length === 0) {
    throw new CLIError("API response did not contain any image data.");
  }

  return items.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new CLIError(`Unexpected image item at index ${index}.`);
    }
    return decodeSingleImageItem(item, response.output_format || outputHint);
  });
}

function decodeSingleImageItem(item, defaultOutputFormat) {
  if (typeof item.b64_json === "string" && item.b64_json.trim()) {
    return {
      bytes: Buffer.from(item.b64_json, "base64"),
      extension: extensionForOutputFormat(defaultOutputFormat)
    };
  }
  if (typeof item.url === "string" && item.url.trim()) {
    return decodeImageUrl(item.url.trim(), defaultOutputFormat);
  }
  throw new CLIError("Image response item did not contain b64_json or url.");
}

function normalizeResponseFormat(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "url" ? "url" : "b64_json";
}

function mimeTypeFromOutputFormat(value) {
  const format = normalizeOutputFormat(value || DEFAULT_OUTPUT_FORMAT);
  const mapping = {
    png: "image/png",
    jpeg: "image/jpeg",
    webp: "image/webp"
  };
  return mapping[format] || "image/png";
}

function decodeImageUrl(value, defaultOutputFormat) {
  if (value.startsWith("data:")) {
    const { mediaType, encoded } = splitDataUrl(value);
    return {
      bytes: Buffer.from(encoded, "base64"),
      extension: extensionForMediaType(mediaType) || extensionForOutputFormat(defaultOutputFormat)
    };
  }
  throw new CLIError("Remote image URLs are not supported in the local saver path; request b64_json or data URLs.");
}

function splitDataUrl(value) {
  const commaIndex = value.indexOf(",");
  if (commaIndex === -1) {
    throw new CLIError("Malformed data URL returned by the API.");
  }
  const header = value.slice(0, commaIndex);
  if (!header.includes(";base64")) {
    throw new CLIError("Only base64 data URLs are supported.");
  }
  const mediaType = header.slice(5).split(";")[0] || "image/png";
  return { mediaType, encoded: value.slice(commaIndex + 1) };
}

function extensionForOutputFormat(value) {
  const format = normalizeOutputFormat(value || DEFAULT_OUTPUT_FORMAT);
  const mapping = {
    png: ".png",
    jpeg: ".jpg",
    webp: ".webp"
  };
  return mapping[format] || ".png";
}

function extensionForMediaType(value) {
  const mapping = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif"
  };
  return mapping[String(value).trim().toLowerCase()] || "";
}

function defaultOutputTarget(decodedImages, overwrite, command) {
  const cwd = process.cwd();
  const commandPrefix = String(command || "").trim().toLowerCase() === "edit" ? "edited" : "generated";

  if (decodedImages.length > 1) {
    const directoryPrefix = `${commandPrefix}-images`;
    if (overwrite) {
      return path.join(cwd, directoryPrefix);
    }
    return nextAvailablePath(cwd, directoryPrefix, "");
  }

  const extension = decodedImages[0].extension || extensionForOutputFormat(DEFAULT_OUTPUT_FORMAT);
  const filePrefix = `${commandPrefix}-image`;
  if (overwrite) {
    return path.join(cwd, `${filePrefix}${extension}`);
  }
  return nextAvailablePath(cwd, filePrefix, extension);
}

function nextAvailablePath(directory, name, extension) {
  const normalizedExtension = String(extension || "");
  const baseCandidate = path.join(directory, `${name}${normalizedExtension}`);
  if (!fs.existsSync(baseCandidate)) {
    return baseCandidate;
  }

  for (let index = 2; index < 10000; index += 1) {
    const candidate = path.join(directory, `${name}_${String(index).padStart(3, "0")}${normalizedExtension}`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new CLIError(`Unable to find an available default output path under ${directory}`);
}

function resolveOutputPaths(outputValue, decodedImages, overwrite, command) {
  if (!Array.isArray(decodedImages) || decodedImages.length === 0) {
    throw new CLIError("No decoded images were available to save.");
  }

  const rawOutput =
    outputValue && String(outputValue).trim() ? String(outputValue) : defaultOutputTarget(decodedImages, overwrite, command);
  const absoluteOutput = path.resolve(rawOutput);
  const outputExists = fs.existsSync(absoluteOutput);
  const treatAsDirectory =
    decodedImages.length > 1 ||
    rawOutput.endsWith("\\") ||
    rawOutput.endsWith("/") ||
    (outputExists && fs.statSync(absoluteOutput).isDirectory());

  const outputPaths = treatAsDirectory
    ? decodedImages.map((item, index) => path.join(absoluteOutput, `image_${String(index + 1).padStart(3, "0")}${item.extension}`))
    : [path.extname(absoluteOutput) ? absoluteOutput : `${absoluteOutput}${decodedImages[0].extension}`];

  const existing = outputPaths.filter((item) => fs.existsSync(item));
  if (existing.length > 0 && !overwrite) {
    throw new CLIError(`Refusing to overwrite existing files without --overwrite: ${existing.join(", ")}`);
  }
  return outputPaths;
}

function finalizeResponse({
  response,
  outputValue,
  outputHint,
  metadataPath,
  overwrite,
  command,
  prompt
}) {
  const decodedImages = decodeImagesFromResponse(response, outputHint);
  const outputPaths = resolveOutputPaths(outputValue, decodedImages, overwrite, command);
  const savedFiles = outputPaths.map((filePath, index) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, decodedImages[index].bytes);
    return filePath;
  });
  const summarizedResponse = summarizeResponseForResult(response);

  const result = {
    command,
    prompt,
    saved_files: savedFiles,
    image_count: savedFiles.length,
    response: summarizedResponse
  };

  if (metadataPath) {
    const target = path.resolve(metadataPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    result.metadata_path = target;
  }

  return result;
}

function summarizeResponseForResult(response) {
  if (!response || typeof response !== "object") {
    return response;
  }

  const summarized = { ...response };
  if (Array.isArray(response.data)) {
    summarized.data = response.data.map((item) => summarizeResponseDataItem(item));
  }
  return summarized;
}

function summarizeResponseDataItem(item) {
  if (!item || typeof item !== "object") {
    return item;
  }

  const summarized = { ...item };
  if (typeof summarized.b64_json === "string") {
    delete summarized.b64_json;
  }
  if (typeof summarized.url === "string" && summarized.url.startsWith("data:")) {
    delete summarized.url;
  }
  return summarized;
}

function printGlobalHelp() {
  process.stdout.write(`cliproxy-image-cli

Generate or edit images using the local Codex OpenAI-compatible configuration.

Usage:
  cliproxy-image-cli [global options] <command> [command options] <prompt>

Commands:
  generate    Generate a new image from a prompt
  edit        Edit one or more source images

Global options:
  --timeout <seconds>      Request timeout (default: ${DEFAULT_TIMEOUT_SECONDS})
  --metadata-path <file>   Optional JSON metadata output path
  --overwrite              Allow overwriting existing output files
  -h, --help               Show this help
`);
}

function printGenerateHelp() {
  process.stdout.write(`Usage:
  cliproxy-image-cli generate [options] [--output <file|dir>] <prompt>

Options:
  --model <name>             Image model (default: ${DEFAULT_MODEL})
  --prompt-file <file>       Read prompt from a UTF-8 text file
  --output <file|dir>        Optional output file path or directory
  --size <WxH>               1024x1024 | 1536x1024 | 1024x1536 | auto (default: ${DEFAULT_SIZE})
  --quality <value>          Image quality
  --background <value>       Background mode
  --moderation <value>       Moderation mode
  --partial-images <count>   Request partial image events
  --output-format <format>   png | jpeg | webp
  --response-format <value>  b64_json | url

If --output is omitted, the CLI saves into the current Codex working directory.
The CLI follows imagegen's size policy: default 1024x1024 unless you pass --size.
The CLI automatically discovers the Codex OpenAI base URL and API key from your local Codex configuration.
`);
}

function printEditHelp() {
  process.stdout.write(`Usage:
  cliproxy-image-cli edit [options] --image <path|url> [--output <file|dir>] <prompt>

Options:
  --image <path|url>         Source image path, URL, or data URL; repeatable
  --mask <path|url>          Optional mask image path, URL, or data URL
  --model <name>             Image model (default: ${DEFAULT_MODEL})
  --prompt-file <file>       Read prompt from a UTF-8 text file
  --output <file|dir>        Optional output file path or directory
  --size <WxH>               1024x1024 | 1536x1024 | 1024x1536 | auto (default: ${DEFAULT_SIZE})
  --quality <value>          Image quality
  --background <value>       Background mode
  --moderation <value>       Moderation mode
  --input-fidelity <value>   Input fidelity hint
  --partial-images <count>   Request partial image events
  --output-format <format>   png | jpeg | webp
  --response-format <value>  b64_json | url

If --output is omitted, the CLI saves into the current Codex working directory.
The CLI follows imagegen's size policy: default 1024x1024 unless you pass --size.
The CLI automatically discovers the Codex OpenAI base URL and API key from your local Codex configuration.
`);
}

module.exports = {
  CLIError,
  DEFAULT_CODEX_HOME,
  DEFAULT_MODEL,
  DEFAULT_OUTPUT_FORMAT,
  DEFAULT_RESPONSES_MODEL,
  DEFAULT_RESPONSE_FORMAT,
  DEFAULT_SIZE,
  DEFAULT_TIMEOUT_SECONDS,
  ALLOWED_IMAGE_SIZES,
  assignOptionalFields,
  buildImagesApiResponseFromResults,
  buildResponsesImageRequest,
  buildApiUrl,
  decodeImagesFromResponse,
  discoverApiKey,
  discoverBaseUrl,
  discoverRuntimeCredentials,
  extensionForOutputFormat,
  finalizeResponse,
  formatUnsupportedImageCapabilityError,
  defaultOutputTarget,
  guessMediaType,
  imageCallResultFromResponsesItem,
  isUnsupportedImageCapabilityError,
  loadCodexConfig,
  main,
  mimeTypeFromOutputFormat,
  normalizeBaseUrl,
  normalizeOutputFormat,
  normalizeSize,
  normalizeResponseFormat,
  loadPreferredTransport,
  parseResponsesImageResponse,
  parseResponsesPayloads,
  parseOptionalInteger,
  parseSimpleToml,
  parseTomlValue,
  persistPreferredTransport,
  preferenceFilePath,
  postImagesViaResponses,
  readPrompt,
  readTransportPreferences,
  requestImageOperation,
  resolveCodexHome,
  resolveOutputPaths,
  sourceToImageReference,
  splitDataUrl,
  stripTomlComment,
  summarizeResponseDataItem,
  summarizeResponseForResult,
  transportPreferenceKey
};
