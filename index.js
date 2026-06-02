const MODULE_NAME = 'st_chat_bias_linker';
const EXTENSION_NAME = 'ST Chat Bias Linker';
const METADATA_KEY = 'st_chat_bias_linker';
const TEXTGEN_BIAS_CONTAINER = '#textgenerationwebui_api-settings';

const defaultSettings = Object.freeze({
    autoApply: true,
    autoUpdateBoundChat: false,
});

let modules = {
    openai: null,
    textgen: null,
    logitBias: null,
};

let isApplying = false;
let lastSignature = '';

function getContext() {
    return SillyTavern.getContext();
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
    const { main_api } = getContext();

    if (main_api === 'openai') {
        return 'chat_completion';
    }

    if (main_api === 'textgenerationwebui') {
        return 'text_completion';
    }

    if (modules.openai?.oai_settings && $('#openai_logit_bias_preset').length) {
        return 'chat_completion';
    }

    if (modules.textgen?.textgenerationwebui_settings && $('#textgenerationwebui_api-settings').length) {
        return 'text_completion';
    }

    return 'unknown';
}

function cloneBiasList(value) {
    return Array.isArray(value) ? structuredClone(value) : [];
}

function getActiveBiasBinding() {
    const mode = getCurrentMode();

    if (mode === 'chat_completion') {
        const selected = modules.openai?.oai_settings?.bias_preset_selected ?? $('#openai_logit_bias_preset').val() ?? '';

        return {
            mode,
            biasPresetName: String(selected || ''),
            updatedAt: Date.now(),
        };
    }

    if (mode === 'text_completion') {
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

    if (binding.mode === 'chat_completion') {
        return binding.biasPresetName
            ? `Chat Completion bias preset: ${binding.biasPresetName}`
            : 'Chat Completion: no bias preset selected';
    }

    if (binding.mode === 'text_completion') {
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
    if (!binding || isApplying) {
        return;
    }

    const signature = JSON.stringify(binding);
    if (signature === lastSignature && silent) {
        return;
    }

    isApplying = true;

    try {
        if (binding.mode === 'chat_completion') {
            await applyChatCompletionBinding(binding);
        } else if (binding.mode === 'text_completion') {
            await applyTextCompletionBinding(binding);
        }

        lastSignature = signature;
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
        isApplying = false;
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
    lastSignature = '';
    toastr?.success('Bias binding cleared for this chat.', EXTENSION_NAME);
}

async function maybeAutoApply() {
    updateUi();

    if (getSettings().autoApply) {
        await applyBinding(getChatBinding(), { silent: true });
    }
}

async function maybeAutoUpdateBinding() {
    if (isApplying || !getSettings().autoUpdateBoundChat || !getChatBinding()) {
        return;
    }

    const binding = getActiveBiasBinding();
    if (binding) {
        await setChatBinding(binding);
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
    $('#stcbl-apply').on('click', () => applyBinding());
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

    updateUi();
}

function updateUi() {
    const settings = getSettings();
    const binding = getChatBinding();
    const mode = getCurrentMode();

    $('#stcbl-auto-apply').prop('checked', settings.autoApply);
    $('#stcbl-auto-update').prop('checked', settings.autoUpdateBoundChat);
    $('#stcbl-status').text(`${getBindingLabel(binding)}. Current API: ${mode.replace('_', ' ')}.`);
    $('#stcbl-apply, #stcbl-clear').prop('disabled', !binding);
}

async function initialize() {
    getSettings();
    await importRuntimeModules();
    buildSettingsUi();

    const { eventSource, event_types } = getContext();
    eventSource.on(event_types.CHAT_CHANGED, maybeAutoApply);
    eventSource.on(event_types.MAIN_API_CHANGED, maybeAutoApply);
    eventSource.on(event_types.PRESET_CHANGED, () => {
        updateUi();
        window.setTimeout(maybeAutoUpdateBinding, 0);
    });

    await maybeAutoApply();
}

const { eventSource, event_types } = getContext();
eventSource.on(event_types.APP_READY, initialize);
