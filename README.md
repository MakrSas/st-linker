# ST Chat Bias Linker

SillyTavern UI extension that binds bias settings to the currently opened chat.

## What it does

- Stores the binding in `chatMetadata`, so every chat can have its own bias.
- For Chat Completion, binds the selected Logit Bias preset.
- For Text Completion, binds the current `logit_bias` list from the active preset/settings.
- Automatically reapplies the bound bias when switching chats if enabled.
- Can optionally update the chat binding whenever the current bias changes.

## Installation

Copy this folder into one of these SillyTavern locations:

- `data/<user-handle>/extensions/st-chat-bias-linker`
- `public/scripts/extensions/third-party/st-chat-bias-linker`

Then reload SillyTavern and enable **ST Chat Bias Linker** in the extensions manager.

## Usage

1. Open a chat.
2. Select or edit the bias settings you want in SillyTavern.
3. Open Extensions settings.
4. In **Chat Bias Linker**, click **Bind current bias**.

When you return to this chat later, the extension applies the saved bias automatically if **Auto-apply on chat switch** is enabled.
