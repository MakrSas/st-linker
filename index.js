const MODULE_NAME = 'st_chat_bias_linker';
const EXTENSION_NAME = 'ST Chat Bias Linker';
const METADATA_KEY = 'st_chat_bias_linker';
const TEXTGEN_BIAS_CONTAINER = '#textgenerationwebui_api-settings';
const CHARACTER_PANEL_ID = 'stcbl-character-overrides';
const CHAT_PROMPT_MANAGER_SELECTOR = '#completion_prompt_manager';
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
    chatPromptOverrides: {},
});

let modules = {
    openai: null,
    textgen: null,
    logitBias: null,
};

let isApplyingBinding = false;
let isApplyingCharacterPromptOverrides = false;
let lastBindingSignature = '';
let scheduledCharacterUiRefresh = 0;
const openAiPromptOrderBase = new Map();

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

function clonePromptOrder(value) {
    return Array.isArray(value) ? structuredClone(value) : [];
}

function promptOrderToMap(order) {
    return new Map(clonePromptOrder(order).map((entry) => [entry.identifier, entry]));
}

function normalizeCharacterConfig(value) {
    const config = structuredClone(defaultCharacterConfig);
    const source = value && typeof value === 'object' ? value : {};
    const sourceOverrides = source.chatPromptOverrides && typeof source.chatPromptOverrides === 'object'
        ? source.chatPromptOverrides
        : {};

    for (const [identifier, state] of Object.entries(sourceOverrides)) {
        if ([TRI_STATE_ON, TRI_STATE_OFF].includes(state)) {
            config.chatPromptOverrides[identifier] = state;
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

    return Object.keys(config.chatPromptOverrides ?? {}).length > 0;
}

function countCharacterOverrides(config = getCharacterConfig()) {
    if (!config) {
        return 0;
    }

    return Object.keys(config.chatPromptOverrides ?? {}).length;
}

async function saveCharacterConfig(config) {
    const context = getContext();

    if (context.characterId === undefined || context.characterId === null) {
        toastr?.warning('Open a character card first.', EXTENSION_NAME);
        return;
    }

    const normalized = normalizeCharacterConfig(config);
    const value = hasCharacterOverrides(normalized)
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

function getCurrentOpenAiPresetName() {
    const presetName = modules.openai?.oai_settings?.preset_settings_openai;
    if (presetName) {
        return String(presetName);
    }

    const selected = $('#settings_preset_openai option:selected').text();
    return String(selected || '');
}

function getCurrentPromptOrder() {
    const promptManager = getPromptManagerInstance();
    const orderEntry = getPromptOrderEntry(promptManager);
    return clonePromptOrder(orderEntry?.order);
}

function getPromptOrderEntry(promptManager = getPromptManagerInstance()) {
    const characterId = promptManager?.activeCharacter?.id;
    const promptOrder = Array.isArray(promptManager?.serviceSettings?.prompt_order)
        ? promptManager.serviceSettings.prompt_order
        : [];

    if (characterId === undefined || characterId === null) {
        return null;
    }

    return promptOrder.find((entry) => String(entry.character_id) === String(characterId)) ?? null;
}

function setCurrentPromptOrder(nextOrder) {
    const promptManager = getPromptManagerInstance();

    if (!promptManager?.activeCharacter) {
        return false;
    }

    let orderEntry = getPromptOrderEntry(promptManager);

    if (!orderEntry) {
        if (typeof promptManager.addPromptOrderForCharacter === 'function') {
            promptManager.addPromptOrderForCharacter(promptManager.activeCharacter, nextOrder);
            orderEntry = getPromptOrderEntry(promptManager);
        } else {
            return false;
        }
    }

    if (!orderEntry) {
        return false;
    }

    orderEntry.order = clonePromptOrder(nextOrder);
    return true;
}

function mergePromptBase(currentOrder, previousBase, overrides) {
    if (!previousBase.length) {
        return clonePromptOrder(currentOrder);
    }

    const previousBaseMap = promptOrderToMap(previousBase);

    return clonePromptOrder(currentOrder).map((entry) => {
        const state = overrides?.[entry.identifier];
        const preserved = previousBaseMap.get(entry.identifier);

        if ([TRI_STATE_ON, TRI_STATE_OFF].includes(state) && preserved) {
            return structuredClone(preserved);
        }

        return structuredClone(entry);
    });
}

function rememberOpenAiPromptBase({ force = false } = {}) {
    if (!modules.openai?.oai_settings || getCurrentMode() !== MODE_CHAT) {
        return;
    }

    const presetName = getCurrentOpenAiPresetName();
    const promptOrder = getCurrentPromptOrder();

    if (!presetName || promptOrder.length === 0) {
        return;
    }

    const previousBase = openAiPromptOrderBase.get(presetName) ?? [];
    const overrides = getCharacterConfig()?.chatPromptOverrides ?? {};
    const nextBase = mergePromptBase(promptOrder, previousBase, overrides);

    if (force || !openAiPromptOrderBase.has(presetName)) {
        openAiPromptOrderBase.set(presetName, nextBase);
    }
}

function getOpenAiPromptBase() {
    const presetName = getCurrentOpenAiPresetName();

    if (!presetName) {
        return [];
    }

    const stored = openAiPromptOrderBase.get(presetName);
    if (stored) {
        return clonePromptOrder(stored);
    }

    const current = getCurrentPromptOrder();
    if (current.length > 0) {
        openAiPromptOrderBase.set(presetName, current);
    }

    return current;
}

function getPromptManagerInstance() {
    if (!modules.openai?.setupChatCompletionPromptManager || !modules.openai?.oai_settings) {
        return null;
    }

    try {
        return modules.openai.setupChatCompletionPromptManager(modules.openai.oai_settings);
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Failed to access prompt manager`, error);
        return null;
    }
}

function refreshPromptManagerUi() {
    const promptManager = getPromptManagerInstance();

    if (typeof promptManager?.render === 'function') {
        promptManager.render(false);
        return;
    }

    if (typeof promptManager?.renderDebounced === 'function') {
        promptManager.renderDebounced();
    }
}

function getPromptName(identifier) {
    const prompts = Array.isArray(modules.openai?.oai_settings?.prompts)
        ? modules.openai.oai_settings.prompts
        : [];

    const prompt = prompts.find((item) => item?.identifier === identifier);
    return prompt?.name || identifier;
}

function getPromptEntriesForUi() {
    if (getCurrentMode() !== MODE_CHAT) {
        return [];
    }

    const baseOrder = getOpenAiPromptBase();

    return baseOrder.map((entry) => ({
        identifier: entry.identifier,
        enabled: Boolean(entry.enabled),
        name: getPromptName(entry.identifier),
    }));
}

async function applyCharacterPromptOverrides({ silent = true } = {}) {
    if (isApplyingCharacterPromptOverrides || !modules.openai?.oai_settings) {
        return;
    }

    const baseOrder = getOpenAiPromptBase();
    if (baseOrder.length === 0) {
        updateCharacterEditorUi();
        updateUi();
        return;
    }

    const config = getCharacterConfig() ?? structuredClone(defaultCharacterConfig);
    const overrides = config.chatPromptOverrides ?? {};
    const nextOrder = baseOrder.map((entry) => {
        const state = overrides[entry.identifier] ?? TRI_STATE_DEFAULT;
        const enabled = state === TRI_STATE_ON
            ? true
            : state === TRI_STATE_OFF
                ? false
                : Boolean(entry.enabled);

        return {
            ...entry,
            enabled,
        };
    });

    const currentSignature = JSON.stringify(getCurrentPromptOrder());
    const nextSignature = JSON.stringify(nextOrder);

    if (currentSignature === nextSignature) {
        updateCharacterEditorUi();
        updateUi();
        return;
    }

    isApplyingCharacterPromptOverrides = true;

    try {
        if (!setCurrentPromptOrder(nextOrder)) {
            throw new Error('Prompt Manager prompt order is not available.');
        }

        refreshPromptManagerUi();
        updateCharacterEditorUi();
        updateUi();

        if (!silent) {
            toastr?.success('Character preset overrides applied.', EXTENSION_NAME);
        }
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Failed to apply character prompt overrides`, error);

        if (!silent) {
            toastr?.error(normalizeError(error), EXTENSION_NAME);
        }
    } finally {
        isApplyingCharacterPromptOverrides = false;
    }
}

async function maybeAutoApply() {
    updateUi();

    if (getSettings().autoApply) {
        await applyBinding(getChatBinding(), { silent: true });
    }

    if (getCurrentMode() === MODE_CHAT) {
        rememberOpenAiPromptBase();
        await applyCharacterPromptOverrides({ silent: true });
    }

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
        [TRI_STATE_ON, 'On'],
        [TRI_STATE_DEFAULT, 'Default'],
        [TRI_STATE_OFF, 'Off'],
    ].map(([optionValue, label]) => {
        const selected = optionValue === value ? ' selected' : '';
        return `<option value="${optionValue}"${selected}>${label}</option>`;
    }).join('');
}

function getCharacterEditorMountTarget() {
    const anchor = document.querySelector('#character_json_data');

    if (!anchor) {
        return null;
    }

    return anchor.closest('.popup-content, .scrollableInner, form, #form_create') ?? anchor.parentElement;
}

function renderPromptOverrideRows(config) {
    const rows = getPromptEntriesForUi();

    if (rows.length === 0) {
        return `
            <div class="stcbl-character-empty">
                Switch to Chat Completion and load a preset to edit prompt overrides.
            </div>
        `;
    }

    return rows.map((row) => {
        const value = config.chatPromptOverrides?.[row.identifier] ?? TRI_STATE_DEFAULT;
        const presetState = row.enabled ? 'On' : 'Off';

        return `
            <label class="stcbl-character-item" for="stcbl-prompt-override-${row.identifier}">
                <span class="stcbl-character-item-label">${row.name}</span>
                <span class="stcbl-character-item-meta">Preset: ${presetState}</span>
                <select
                    id="stcbl-prompt-override-${row.identifier}"
                    class="text_pole stcbl-character-select"
                    data-prompt-identifier="${row.identifier}"
                >
                    ${renderTriStateOptions(value)}
                </select>
            </label>
        `;
    }).join('');
}

function renderCharacterEditorContent() {
    const character = getActiveCharacter();

    if (!character) {
        return `
            <hr class="sysHR">
            <div class="stcbl-character-note">Select a character to edit prompt overrides.</div>
        `;
    }

    const config = getCharacterConfig() ?? structuredClone(defaultCharacterConfig);
    const presetName = getCurrentMode() === MODE_CHAT
        ? (getCurrentOpenAiPresetName() || 'Not selected')
        : 'Chat Completion only';

    return `
        <hr class="sysHR">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Preset Switch Overrides</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="stcbl-character-note">
                    Current preset: ${presetName}
                </div>
                <div class="stcbl-character-note">
                    Default keeps the current preset value. On and Off force the prompt toggle for this character only.
                </div>
                <div class="stcbl-character-summary">
                    Forced prompt overrides: ${countCharacterOverrides(config)}
                </div>
                <div class="stcbl-character-grid">
                    ${renderPromptOverrideRows(config)}
                </div>
                <div class="stcbl-character-actions">
                    <input id="stcbl-reset-prompts" class="menu_button" type="button" value="Reset prompt overrides">
                </div>
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
        await applyCharacterPromptOverrides({ silent: false });
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
        const identifier = String($(this).data('prompt-identifier') || '');
        const value = String($(this).val() || TRI_STATE_DEFAULT);
        const config = getCharacterConfig() ?? structuredClone(defaultCharacterConfig);

        if (!identifier) {
            return;
        }

        if (value === TRI_STATE_DEFAULT) {
            delete config.chatPromptOverrides[identifier];
        } else {
            config.chatPromptOverrides[identifier] = value;
        }

        await saveCharacterConfig(config);
        await applyCharacterPromptOverrides({ silent: true });
    });

    $(document).on('click', '#stcbl-reset-prompts', async () => {
        const config = structuredClone(defaultCharacterConfig);
        await saveCharacterConfig(config);
        await applyCharacterPromptOverrides({ silent: true });
    });

    $(document).on('change', '#settings_preset_openai', () => {
        window.setTimeout(async () => {
            rememberOpenAiPromptBase({ force: true });
            await applyCharacterPromptOverrides({ silent: true });
            updateCharacterEditorUi();
        }, 0);
    });

    $(document).on('click', `${CHAT_PROMPT_MANAGER_SELECTOR} .prompt-manager-toggle-action`, () => {
        window.setTimeout(async () => {
            rememberOpenAiPromptBase({ force: true });
            await applyCharacterPromptOverrides({ silent: true });
            updateCharacterEditorUi();
        }, 0);
    });

    $(document).on('click', [
        `${CHAT_PROMPT_MANAGER_SELECTOR} .prompt-manager-detach-action`,
        `${CHAT_PROMPT_MANAGER_SELECTOR} .prompt-manager-edit-action`,
        `${CHAT_PROMPT_MANAGER_SELECTOR} .menu_button`,
    ].join(', '), () => {
        window.setTimeout(() => {
            rememberOpenAiPromptBase({ force: true });
            updateCharacterEditorUi();
        }, 0);
    });

    updateUi();
}

function updateUi() {
    const settings = getSettings();
    const binding = getChatBinding();
    const mode = getCurrentMode();
    const overrideCount = countCharacterOverrides();
    const characterLabel = getActiveCharacter()
        ? `Character prompt overrides: ${overrideCount}`
        : 'Character prompt overrides: no active character';

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
    rememberOpenAiPromptBase({ force: true });

    const { eventSource, event_types } = getContext();
    eventSource.on(event_types.CHAT_CHANGED, maybeAutoApply);
    eventSource.on(event_types.MAIN_API_CHANGED, async () => {
        rememberOpenAiPromptBase({ force: true });
        await maybeAutoApply();
        updateCharacterEditorUi();
    });
    eventSource.on(event_types.PRESET_CHANGED, () => {
        window.setTimeout(async () => {
            rememberOpenAiPromptBase({ force: true });
            await maybeAutoUpdateBinding();
            await applyCharacterPromptOverrides({ silent: true });
            updateCharacterEditorUi();
            updateUi();
        }, 0);
    });
    eventSource.on(event_types.CHARACTER_EDITOR_OPENED, scheduleCharacterEditorUiRefresh);
    eventSource.on(event_types.CHARACTER_PAGE_LOADED, scheduleCharacterEditorUiRefresh);
    eventSource.on(event_types.CHARACTER_EDITED, scheduleCharacterEditorUiRefresh);

    await maybeAutoApply();
}

const { eventSource, event_types } = getContext();
eventSource.on(event_types.APP_READY, initialize);
