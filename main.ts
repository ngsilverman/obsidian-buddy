import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';

// Remember to rename these classes and interfaces!

interface BuddySettings {
	openAIApiKey: string;
}

const DEFAULT_SETTINGS: BuddySettings = {
	openAIApiKey: ''
}

const sanitizeContent = (s: string): string => {
	return s.replace(/^\s+|\s+$/g, "");
};

const sanitizeAssistantContent = (s: string): string => {
	return sanitizeContent(s.replace(/^>\s?/gm, ""));
};

interface Message {
	role: string;
	content: string;
}

const gptMessages = (s: string): Message[] => {
	const lines = s.split("\n");
	let messages: Message[] = [];
	let role: string | null = null;
	let content: string | null = null;

	while (lines.length > 0) {
		const line = lines.shift()!;
		const updateMessages = (): Message[] => {
			if (content !== null) {
				const sanitizeF = role === "assistant" ? sanitizeAssistantContent : sanitizeContent;
				messages.push({ role: role!, content: sanitizeF(content) });
			}
			return messages;
		};

		if (line.match(/^> \[!gpt-assistant\]/)) {
			updateMessages();
			role = "assistant";
			content = null;
		} else if (role === "assistant" && line.match(/^>/)) {
			content = content ? `${content}\n${line}` : line;
		} else if (role === null) {
			role = "user";
			content = line;
		} else if (role === "assistant") {
			updateMessages();
			role = "user";
			content = line;
		} else {
			content = content ? `${content}\n${line}` : line;
		}
	}

	if (content !== null && role !== null) {
		const sanitizeF = role === "assistant" ? sanitizeAssistantContent : sanitizeContent;
		messages.push({ role: role, content: sanitizeF(content) });
	}

	return messages;
};

export default class BuddyPlugin extends Plugin {
	settings: BuddySettings;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: 'buddy-chat',
			name: 'Let\'s have a chat',
			checkCallback: (checking: boolean) => {
				// Conditions to check
				const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView) {
					// If checking is true, we're simply "checking" if the command can be run.
					// If checking is false, then we want to actually perform the operation.
					if (!checking) {
						console.log(markdownView.getViewData())
						console.log(gptMessages(markdownView.getViewData()))
					}

					// This command will only show up in Command Palette when the check function returns true
					return true;
				}
			}
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new BuddySettingTab(this.app, this));
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class BuddySettingTab extends PluginSettingTab {
	plugin: BuddyPlugin;

	constructor(app: App, plugin: BuddyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('OpenAI API key')
			.addText(text => text
				.setValue(this.plugin.settings.openAIApiKey)
				.onChange(async (value) => {
					this.plugin.settings.openAIApiKey = value;
					await this.plugin.saveSettings();
				}));
	}
}
