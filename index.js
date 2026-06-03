const MODULE_NAME = 'st_chat_bias_linker';
const EXTENSION_NAME = 'ST Chat Bias Linker';
const METADATA_KEY = 'st_chat_bias_linker';
const TEXTGEN_BIAS_CONTAINER = '#textgenerationwebui_api-settings';
const CHARACTER_PANEL_ID = 'stcbl-character-overrides';
const MODE_CHAT = 'chat_completion';
const MODE_TEXT = 'text_completion';
const TRI_STATE_DEFAULT = 'default';
const TRI_STATE_ON = 'on';
const TRI_STATE_OFF = 'off';

const defaultSettings = Object.freeze({
    autoApply: true,
    autoUpdateBoundChat: false,
});

const defaultCharacterConfig = Object.freeze({
    presetBooleanOverrides: {
        [MODE_CHAT]: {},
        [MODE_TEXT]: {},
    },
});

const excludedBooleanKeys = Object.freeze({
    [MODE_CHAT]: new Set(['bind_preset_to_connection']),
    [MODE_TEXT]: new Set([]),
});

const settingLabels = Object.freeze({
    add_bos_token: 'Add BOS Token',
    assistant_impersonation: 'Assistant Impersonation',
    assistant_prefill: 'Assistant Prefill',
    ban_eos_token: 'Ban EOS Token',
    bypass_status_check: 'Bypass Status Check',
    continue_prefill: 'Continue Prefill',
    do_sample: 'Do Sample',
    dynatemp: 'Dynamic Temperature',
    enable_web_search: 'Web Search',
    function_calling: 'Function Calling',
    group_models: 'Group Models',
    ignore_eos_token: 'Ignore EOS Token',
    include_reasoning: 'Include Reasoning',
    max_context_unlocked: 'Max Context Unlocked',
    media_inlining: 'Media Inlining',
    nanogpt_payg_override: 'NanoGPT PAYG Override',
    openrouter_allow_fallbacks: 'OpenRouter Allow Fallbacks',
    openrouter_use_fallback: 'OpenRouter Use Fallback',
    request_images: 'Request Images',
    send_banned_tokens: 'Send Banned Tokens',
    show_external_models: 'Show External Models',
    show_thoughts: 'Show Thoughts',
    skip_special_tokens: 'Skip Special Tokens',
    spaces_between_special_tokens: 'Spaces Between Special Tokens',
    speculative_ngram: 'Speculative Ngram',
    squash_system_messages: 'Squash System Messages',
    stream_openai: 'Streaming',
    streaming: 'Streaming',
    temperature_last: 'Temperature Last',
    use_sysprompt: 'Use System Prompt',
});

const textCompletionSelectorMap = Object.freeze({
    add_bos_token: '#add_bos_token',
    ban_eos_token: '#ban_eos_token',
    bypass_status_check: '#textgenerationwebui_bypass_status_check, #bypass_status_check',
    do_sample: '#do_sample',
    dynatemp: '#dynatemp',
    early_stopping: '#early_stopping',
    ignore_eos_token: '#ignore_eos_token',
    include_reasoning: '#include_reasoning',
    openrouter_allow_fallbacks: '#openrouter_allow_fallbacks',
    send_banned_tokens: '#send_banned_tokens_textgenerationwebui, #send_banned_tokens',
    skip_special_tokens: '#skip_special_tokens',
    spaces_between_special_tokens: '#spaces_between_special_tokens',
    speculative_ngram: '#speculative_ngram',
    streaming: '#streaming_textgenerationwebui, #streaming',
    temperature_last: '#temperature_last',
});

let modules = {
    openai: null,
    textgen: null,
    logitBias: null,
};

let isApplyingBinding = false;
let isApplyingCharacterOverrides = false;
let lastBindingSignature = '';
let scheduledCharacterUiRefresh = 0;

function getContext() {
    return SillyTavern.getContext();
}

function getCurrentMainApi() {
    const context = getContext();
    return context.mainApi ?? context.main_api ?? '';
}

function getSettings() {
    const { extensionSettings } = getContext();

    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }

    for (const [key, value] of Object.entries(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = value;
        }
    }

    return extensionSettings[MODULE_NAME];
}

function cloneBiasList(value) {
    return Array.isArray(value) ? structuredClone(value) : [];
}

function normalizeCharacterConfig(value) {
    const config = structuredClone(defaultCharacterConfig);
    const source = value && typeof value === 'object' ? value : {};
    const sourceOverrides = source.presetBooleanOverrides && typeof source.presetBooleanOverrides === 'object'
        ? source.presetBooleanOverrides
        : {};

    for (const mode of [MODE_CHAT, MODE_TEXT]) {
        const modeOverrides = sourceOverrides[mode] && typeof sourceOverrides[mode] === 'object'
            ? sourceOverrides[mode]
            : {};

        for (const [key, state] of Object.entries(modeOverrides)) {
            if ([TRI_STATE_ON, TRI_STATE_OFF].includes(state)) {
                config.presetBooleanOverrides[mode][key] = state;
            }
        }
    }

    return config;
}

function getActiveCharacter() {
    const { characterId, characters } = getContext();
    if (characterId === undefined || characterId === null) {
        return null;
    }

    return characters?.[characterId] ?? null;
}

function parseCharacterJsonData(character) {
    if (!character?.json_data) {
        return null;
    }

    try {
        return JSON.parse(character.json_data);
    } catch {
        return null;
    }
}

function getCharacterConfig(characterId = getContext().characterId) {
    if (characterId === undefined || characterId === null) {
        return null;
    }

    const { characters } = getContext();
    const character = characters?.[characterId];
    if (!character) {
        return null;
    }

    const fromData = character.data?.extensions?.[MODULE_NAME];
    if (fromData && typeof fromData === 'object') {
        return normalizeCharacterConfig(fromData);
    }

    const jsonData = parseCharacterJsonData(character);
    return normalizeCharacterConfig(jsonData?.data?.extensions?.[MODULE_NAME]);
}

function hasCharacterOverrides(config = getCharacterConfig()) {
    if (!config) {
        return false;
    }

    return [MODE_CHAT, MODE_TEXT].some((mode) => Object.keys(config.presetBooleanOverrides?.[mode] ?? {}).length > 0);
}

function countCharacterOverrides(config = getCharacterConfig()) {
    if (!config) {
        return 0;
    }

    return [MODE_CHAT, MODE_TEXT].reduce((total, mode) => {
        return total + Object.keys(config.presetBooleanOverrides?.[mode] ?? {}).length;
    }, 0);
}

async function saveCharacterConfig(config) {
    const context = getContext();

    if (context.characterId === undefined || context.characterId === null) {
        toastr?.warning('Open a character card first.', EXTENSION_NAME);
        return;
    }

    const normalized = normalizeCharacterConfig(config);
    const hasOverrides = hasCharacterOverrides(normalized);
    const value = hasOverrides
        ? normalized
        : (context.constants?.unset ?? normalized);

    await context.writeExtensionField(context.characterId, MODULE_NAME, value);
    updateCharacterEditorUi();
    updateUi();
}

function getChatBinding() {
    return getContext().chatMetadata?.[METADATA_KEY] ?? null;
}

async function setChatBinding(binding) {
    const context = getContext();

    if (!context.chatMetadata) {
        toastr?.warning('Open a chat first.', EXTENSION_NAME);
        return;
    }

    if (binding) {
        context.chatMetadata[METADATA_KEY] = binding;
    } else {
        delete context.chatMetadata[METADATA_KEY];
    }

    await context.saveMetadata();
    updateUi();
}

async function importRuntimeModules() {
    const imports = [
        import('/scripts/openai.js').catch(() => null),
        import('/scripts/textgen-settings.js').catch(() => null),
        import('/scripts/logit-bias.js').catch(() => null),
    ];

    const [openai, textgen, logitBias] = await Promise.all(imports);
    modules = { openai, textgen, logitBias };
}

function getCurrentMode() {
    const mainApi = getCurrentMainApi();

    if (mainApi === 'openai') {
        return MODE_CHAT;
    }

    if (mainApi === 'textgenerationwebui') {
        return MODE_TEXT;
    }

    if (modules.openai?.oai_settings && $('#openai_logit_bias_preset').length) {
        return MODE_CHAT;
    }

    if (modules.textgen?.textgenerationwebui_settings && $('#textgenerationwebui_api-settings').length) {
        return MODE_TEXT;
    }

    return 'unknown';
}

function getActiveBiasBinding() {
    const mode = getCurrentMode();

    if (mode === MODE_CHAT) {
        const selected = modules.openai?.oai_settings?.bias_preset_selected ?? $('#openai_logit_bias_preset').val() ?? '';

        return {
            mode,
            biasPresetName: String(selected || ''),
            updatedAt: Date.now(),
        };
    }

    if (mode === MODE_TEXT) {
        return {
            mode,
            logitBias: cloneBiasList(modules.textgen?.textgenerationwebui_settings?.logit_bias),
            updatedAt: Date.now(),
        };
    }

    return null;
}

function getBindingLabel(binding = getChatBinding()) {
    if (!binding) {
        return 'No bias bound to this chat';
    }

    if (binding.mode === MODE_CHAT) {
        return binding.biasPresetName
            ? `Chat Completion bias preset: ${binding.biasPresetName}`
            : 'Chat Completion: no bias preset selected';
    }

    if (binding.mode === MODE_TEXT) {
        const count = Array.isArray(binding.logitBias) ? binding.logitBias.length : 0;
        return `Text Completion logit bias entries: ${count}`;
    }

    return 'Unknown binding';
}

function normalizeError(error) {
    return error instanceof Error ? error.message : String(error);
}

function humanizeSettingName(key) {
    if (settingLabels[key]) {
        return settingLabels[key];
    }

    return key
        .split('_')
        .filter(Boolean)
        .map((part) => {
            if (['api', 'cfg', 'eos', 'bos', 'oai'].includes(part)) {
                return part.toUpperCase();
            }

            return part.charAt(0).toUpperCase() + part.slice(1);
        })
        .join(' ');
}

function getBooleanSettingKeys(mode) {
    const source = mode === MODE_CHAT
        ? modules.openai?.oai_settings
        : modules.textgen?.textgenerationwebui_settings;

    if (!source || typeof source !== 'object') {
        return [];
    }

    const excluded = excludedBooleanKeys[mode] ?? new Set();

    return Object.keys(source)
        .filter((key) => typeof source[key] === 'boolean' && !excluded.has(key))
        .sort((left, right) => humanizeSettingName(left).localeCompare(humanizeSettingName(right)));
}

function getOpenAiSelector(key) {
    const entry = modules.openai?.settingsToUpdate?.[key];
    return Array.isArray(entry) ? entry[0] : '';
}

function getTextCompletionSelector(key) {
    if (textCompletionSelectorMap[key]) {
        return textCompletionSelectorMap[key];
    }

    return [`#${key}`, `#${key}_textgenerationwebui`].join(', ');
}

function applyBooleanSelector(selector, value) {
    if (!selector) {
        return false;
    }

    const $element = $(selector).first();
    if (!$element.length) {
        return false;
    }

    if ($element.is(':checkbox')) {
        $element.prop('checked', value).trigger('input', { source: MODULE_NAME }).trigger('change', { source: MODULE_NAME });
        return true;
    }

    $element.val(String(value)).trigger('input', { source: MODULE_NAME }).trigger('change', { source: MODULE_NAME });
    return true;
}

async function applyChatCompletionBinding(binding) {
    if (!modules.openai?.oai_settings) {
        throw new Error('Chat Completion settings are not available.');
    }

    const presetName = binding.biasPresetName || '';
    const hasPreset = presetName && Object.hasOwn(modules.openai.oai_settings.bias_presets ?? {}, presetName);

    if (presetName && !hasPreset) {
        throw new Error(`Bias preset "${presetName}" was not found.`);
    }

    modules.openai.oai_settings.bias_preset_selected = presetName || null;
    $('#openai_logit_bias_preset').val(presetName).trigger('change', { source: MODULE_NAME });
    getContext().saveSettingsDebounced();
}

async function applyTextCompletionBinding(binding) {
    if (!modules.textgen?.textgenerationwebui_settings) {
        throw new Error('Text Completion settings are not available.');
    }

    const logitBias = cloneBiasList(binding.logitBias);
    modules.textgen.textgenerationwebui_settings.logit_bias = logitBias;

    if (modules.logitBias?.BIAS_CACHE) {
        modules.logitBias.BIAS_CACHE.delete(TEXTGEN_BIAS_CONTAINER);
    }

    if (modules.logitBias?.displayLogitBias) {
        modules.logitBias.displayLogitBias(logitBias, TEXTGEN_BIAS_CONTAINER);
    }

    getContext().saveSettingsDebounced();
}

function applyChatCompletionPresetOverrides(overrides) {
    const settings = modules.openai?.oai_settings;

    if (!settings) {
        return 0;
    }

    let applied = 0;

    for (const [key, state] of Object.entries(overrides ?? {})) {
        if (![TRI_STATE_ON, TRI_STATE_OFF].includes(state) || typeof settings[key] !== 'boolean') {
            continue;
        }

        const value = state === TRI_STATE_ON;
        settings[key] = value;
        applyBooleanSelector(getOpenAiSelector(key), value);
        applied++;
    }

    return applied;
}

function applyTextCompletionPresetOverrides(overrides) {
    const settings = modules.textgen?.textgenerationwebui_settings;

    if (!settings) {
        return 0;
    }

    let applied = 0;

    for (const [key, state] of Object.entries(overrides ?? {})) {
        if (![TRI_STATE_ON, TRI_STATE_OFF].includes(state) || typeof settings[key] !== 'boolean') {
            continue;
        }

        const value = state === TRI_STATE_ON;
        settings[key] = value;
        applyBooleanSelector(getTextCompletionSelector(key), value);
        applied++;
    }

    return applied;
}

async function applyCharacterPresetOverrides({ silent = true } = {}) {
    if (isApplyingCharacterOverrides) {
        return;
    }

    const mode = getCurrentMode();
    const characterConfig = getCharacterConfig();

    if (!characterConfig || ![MODE_CHAT, MODE_TEXT].includes(mode)) {
        updateCharacterEditorUi();
        updateUi();
        return;
    }

    const overrides = characterConfig.presetBooleanOverrides?.[mode] ?? {};
    if (Object.keys(overrides).length === 0) {
        updateCharacterEditorUi();
        updateUi();
        return;
    }

    isApplyingCharacterOverrides = true;

    try {
        const applied = mode === MODE_CHAT
            ? applyChatCompletionPresetOverrides(overrides)
            : applyTextCompletionPresetOverrides(overrides);

        if (applied > 0) {
            getContext().saveSettingsDebounced();

            if (!silent) {
                toastr?.success('Character preset overrides applied.', EXTENSION_NAME);
            }
        }
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Failed to apply character overrides`, error);

        if (!silent) {
            toastr?.error(normalizeError(error), EXTENSION_NAME);
        }
    } finally {
        isApplyingCharacterOverrides = false;
        updateCharacterEditorUi();
        updateUi();
    }
}

async function applyBinding(binding = getChatBinding(), { silent = false } = {}) {
    if (!binding || isApplyingBinding) {
        return;
    }

    const signature = JSON.stringify(binding);
    if (signature === lastBindingSignature && silent) {
        return;
    }

    isApplyingBinding = true;

    try {
        if (binding.mode === MODE_CHAT) {
            await applyChatCompletionBinding(binding);
        } else if (binding.mode === MODE_TEXT) {
            await applyTextCompletionBinding(binding);
        }

        lastBindingSignature = signature;
        updateUi();

        if (!silent) {
            toastr?.success('Bias binding applied.', EXTENSION_NAME);
        }
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Failed to apply binding`, error);

        if (!silent) {
            toastr?.error(normalizeError(error), EXTENSION_NAME);
        }
    } finally {
        isApplyingBinding = false;
    }
}

async function bindCurrentBias() {
    const binding = getActiveBiasBinding();

    if (!binding) {
        toastr?.warning('Current API does not expose supported bias settings.', EXTENSION_NAME);
        return;
    }

    await setChatBinding(binding);
    toastr?.success('Current bias is bound to this chat.', EXTENSION_NAME);
}

async function clearBinding() {
    await setChatBinding(null);
    lastBindingSignature = '';
    toastr?.success('Bias binding cleared for this chat.', EXTENSION_NAME);
}

async function maybeAutoApply() {
    updateUi();

    if (getSettings().autoApply) {
        await applyBinding(getChatBinding(), { silent: true });
    }

    await applyCharacterPresetOverrides({ silent: true });
    updateCharacterEditorUi();
}

async function maybeAutoUpdateBinding() {
    if (isApplyingBinding || !getSettings().autoUpdateBoundChat || !getChatBinding()) {
        return;
    }

    const binding = getActiveBiasBinding();
    if (binding) {
        await setChatBinding(binding);
    }
}

function renderTriStateOptions(value) {
    return [
        [TRI_STATE_DEFAULT, 'Default'],
        [TRI_STATE_ON, 'Always on'],
        [TRI_STATE_OFF, 'Always off'],
    ].map(([optionValue, label]) => {
        const selected = optionValue === value ? ' selected' : '';
        return `<option value="${optionValue}"${selected}>${label}</option>`;
    }).join('');
}

function renderModeOverrideSection(mode, title, config) {
    const keys = getBooleanSettingKeys(mode);

    if (keys.length === 0) {
        return `
            <div class="stcbl-character-mode">
                <div class="stcbl-character-mode-title">${title}</div>
                <div class="stcbl-character-empty">Settings are not available in this client state.</div>
            </div>
        `;
    }

    const overrides = config?.presetBooleanOverrides?.[mode] ?? {};
    const rows = keys.map((key) => {
        const value = overrides[key] ?? TRI_STATE_DEFAULT;

        return `
            <label class="stcbl-character-item" for="stcbl-character-${mode}-${key}">
                <span class="stcbl-character-item-label">${humanizeSettingName(key)}</span>
                <select
                    id="stcbl-character-${mode}-${key}"
                    class="text_pole stcbl-character-select"
                    data-mode="${mode}"
                    data-key="${key}"
                >
                    ${renderTriStateOptions(value)}
                </select>
            </label>
        `;
    }).join('');

    return `
        <div class="stcbl-character-mode">
            <div class="stcbl-character-mode-header">
                <div class="stcbl-character-mode-title">${title}</div>
                <input
                    type="button"
                    class="menu_button stcbl-character-reset"
                    data-mode="${mode}"
                    value="Reset section"
                >
            </div>
            <div class="stcbl-character-grid">
                ${rows}
            </div>
        </div>
    `;
}

function getCharacterEditorMountTarget() {
    const anchor = document.querySelector('#character_json_data');

    if (!anchor) {
        return null;
    }

    return anchor.closest('.popup-content, .scrollableInner, form, #form_create') ?? anchor.parentElement;
}

function renderCharacterEditorContent() {
    const character = getActiveCharacter();

    if (!character) {
        return `
            <hr class="sysHR">
            <div class="stcbl-character-note">Select a character to edit preset overrides.</div>
        `;
    }

    const config = getCharacterConfig();
    const overrideCount = countCharacterOverrides(config);

    return `
        <hr class="sysHR">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Preset Switch Overrides</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="stcbl-character-note">
                    Default keeps the value from the active SillyTavern preset. Always on and Always off are stored in the character card.
                </div>
                <div class="stcbl-character-summary">
                    Forced preset switches: ${overrideCount}
                </div>
                ${renderModeOverrideSection(MODE_CHAT, 'Chat Completion', config)}
                ${renderModeOverrideSection(MODE_TEXT, 'Text Completion', config)}
            </div>
        </div>
    `;
}

function ensureCharacterEditorUi() {
    const mountTarget = getCharacterEditorMountTarget();
    if (!mountTarget) {
        return;
    }

    let panel = document.getElementById(CHARACTER_PANEL_ID);

    if (!panel) {
        panel = document.createElement('div');
        panel.id = CHARACTER_PANEL_ID;
        panel.className = 'stcbl-character-settings';
        mountTarget.appendChild(panel);
    } else if (!mountTarget.contains(panel)) {
        mountTarget.appendChild(panel);
    }

    panel.innerHTML = renderCharacterEditorContent();
}

function scheduleCharacterEditorUiRefresh() {
    if (scheduledCharacterUiRefresh) {
        window.clearTimeout(scheduledCharacterUiRefresh);
    }

    scheduledCharacterUiRefresh = window.setTimeout(() => {
        scheduledCharacterUiRefresh = 0;
        ensureCharacterEditorUi();
    }, 50);
}

function updateCharacterEditorUi() {
    if (document.getElementById(CHARACTER_PANEL_ID)) {
        ensureCharacterEditorUi();
    } else {
        scheduleCharacterEditorUiRefresh();
    }
}

function buildSettingsUi() {
    if ($('#st-chat-bias-linker').length) {
        return;
    }

    const html = `
        <div id="st-chat-bias-linker" class="stcbl-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Chat Bias Linker</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="stcbl-row">
                        <label class="checkbox_label" for="stcbl-auto-apply">
                            <input id="stcbl-auto-apply" type="checkbox">
                            <span>Auto-apply on chat switch</span>
                        </label>
                    </div>
                    <div class="stcbl-row">
                        <label class="checkbox_label" for="stcbl-auto-update">
                            <input id="stcbl-auto-update" type="checkbox">
                            <span>Update bound chat when bias changes</span>
                        </label>
                    </div>
                    <div id="stcbl-status" class="stcbl-status"></div>
                    <div class="stcbl-actions">
                        <input id="stcbl-bind" class="menu_button" type="button" value="Bind current bias">
                        <input id="stcbl-apply" class="menu_button" type="button" value="Apply now">
                        <input id="stcbl-clear" class="menu_button" type="button" value="Clear chat binding">
                    </div>
                </div>
            </div>
        </div>
    `;

    $('#extensions_settings2').append(html);

    $('#stcbl-auto-apply').on('change', function () {
        getSettings().autoApply = Boolean($(this).prop('checked'));
        getContext().saveSettingsDebounced();
    });

    $('#stcbl-auto-update').on('change', function () {
        getSettings().autoUpdateBoundChat = Boolean($(this).prop('checked'));
        getContext().saveSettingsDebounced();
    });

    $('#stcbl-bind').on('click', bindCurrentBias);
    $('#stcbl-apply').on('click', async () => {
        await applyBinding();
        await applyCharacterPresetOverrides({ silent: false });
    });
    $('#stcbl-clear').on('click', clearBinding);

    $(document).on('change input click', [
        '#openai_logit_bias_preset',
        '#textgen_logit_bias_new_entry',
        '#textgenerationwebui_api-settings .logit_bias_text',
        '#textgenerationwebui_api-settings .logit_bias_value',
        '#textgenerationwebui_api-settings .logit_bias_remove',
    ].join(', '), () => {
        window.setTimeout(maybeAutoUpdateBinding, 0);
    });

    $(document).on('change', '.stcbl-character-select', async function () {
        const mode = String($(this).data('mode') || '');
        const key = String($(this).data('key') || '');
        const value = String($(this).val() || TRI_STATE_DEFAULT);
        const config = getCharacterConfig() ?? structuredClone(defaultCharacterConfig);

        if (![MODE_CHAT, MODE_TEXT].includes(mode) || !key) {
            return;
        }

        if (value === TRI_STATE_DEFAULT) {
            delete config.presetBooleanOverrides[mode][key];
        } else {
            config.presetBooleanOverrides[mode][key] = value;
        }

        await saveCharacterConfig(config);
        await applyCharacterPresetOverrides({ silent: true });
    });

    $(document).on('click', '.stcbl-character-reset', async function () {
        const mode = String($(this).data('mode') || '');
        const config = getCharacterConfig() ?? structuredClone(defaultCharacterConfig);

        if (![MODE_CHAT, MODE_TEXT].includes(mode)) {
            return;
        }

        config.presetBooleanOverrides[mode] = {};
        await saveCharacterConfig(config);
        await applyCharacterPresetOverrides({ silent: true });
    });

    $(document).on('change input', '#ai_response_configuration input[type="checkbox"]', () => {
        if (!isApplyingCharacterOverrides) {
            window.setTimeout(() => applyCharacterPresetOverrides({ silent: true }), 0);
        }
    });

    updateUi();
}

function updateUi() {
    const settings = getSettings();
    const binding = getChatBinding();
    const mode = getCurrentMode();
    const overrideCount = countCharacterOverrides();
    const characterLabel = getActiveCharacter()
        ? `Character preset overrides: ${overrideCount}`
        : 'Character preset overrides: no active character';

    $('#stcbl-auto-apply').prop('checked', settings.autoApply);
    $('#stcbl-auto-update').prop('checked', settings.autoUpdateBoundChat);
    $('#stcbl-status').text(`${getBindingLabel(binding)}. Current API: ${mode.replace('_', ' ')}. ${characterLabel}.`);
    $('#stcbl-apply, #stcbl-clear').prop('disabled', !binding);
}

async function initialize() {
    getSettings();
    await importRuntimeModules();
    buildSettingsUi();
    scheduleCharacterEditorUiRefresh();

    const { eventSource, event_types } = getContext();
    eventSource.on(event_types.CHAT_CHANGED, maybeAutoApply);
    eventSource.on(event_types.MAIN_API_CHANGED, async () => {
        await maybeAutoApply();
        updateCharacterEditorUi();
    });
    eventSource.on(event_types.PRESET_CHANGED, () => {
        updateUi();
        updateCharacterEditorUi();
        window.setTimeout(maybeAutoUpdateBinding, 0);
        window.setTimeout(() => applyCharacterPresetOverrides({ silent: true }), 0);
    });
    eventSource.on(event_types.CHARACTER_EDITOR_OPENED, scheduleCharacterEditorUiRefresh);
    eventSource.on(event_types.CHARACTER_PAGE_LOADED, scheduleCharacterEditorUiRefresh);
    eventSource.on(event_types.CHARACTER_EDITED, scheduleCharacterEditorUiRefresh);

    await maybeAutoApply();
}

const { eventSource, event_types } = getContext();
eventSource.on(event_types.APP_READY, initialize);
