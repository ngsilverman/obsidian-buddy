import { App, MarkdownRenderer, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, ToggleComponent } from 'obsidian';
import OpenAI from "openai";

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

interface Message {
	role: string;
	content: string;
}

const gptMessages = (md: string): Message[] => {
	const lines = md.split("\n");
	let messages: Message[] = [];
	let role: string | null = null;
	let content: string | null = null;

	const updateMessages = (): Message[] => {
		if (content !== null) {
			const sanitizedContent = sanitizeContent(content);
			if (sanitizedContent) {
				messages.push({ role: role!, content: sanitizedContent });
				role = null;
				content = null;
			}
		}
		return messages;
	};

	while (lines.length > 0) {
		const line = lines.shift()!;

		if (role !== "assistant" && line.match(/^```buddy\s*$/)) {
			updateMessages();
			role = "assistant";
		} else if (role === "assistant" && line.match(/^```\s*$/)) {
			updateMessages();
			role = "user";
		} else if (role === null) {
			role = "user";
			content = line;
		} else {
			content = content ? `${content}\n${line}` : line;
		}
	}

	if (content !== null && role !== null) {
		if (role === "assistant") {
			new Notice('Error: buddy code block has no end');
			throw new Error("buddy code block has no end");
		} else {
			updateMessages();
		}
	}

	return messages;
};

const messageToMd = (m: Message): string => {
	if (m.role === "assistant") {
		return `\n\`\`\`buddy\n${m.content}\n\`\`\``;
	} else {
		return `\n${m.content}`;
	}
};

function removeLines(s: string, start: number, end: number) {
	const lines = s.split('\n');
	lines.splice(start, end - start + 1);
	return lines.join('\n');
}

function markdownViewToMd(view: MarkdownView, removeProps: boolean = false): string {
	let md = view.getViewData();
	if (removeProps) {
		const cache = this.app.metadataCache.getFileCache(view.file!);
		if (cache?.frontmatter) {
			const { start, end } = cache.frontmatterPosition!;
			md = removeLines(md, start.line, end.line);
		}
	}
	return md;
}

export default class BuddyPlugin extends Plugin {
	settings: BuddySettings;

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new BuddySettingTab(this.app, this));

		// TODO: Check that an API key has been set.
		const openai = new OpenAI({
			apiKey: this.settings.openAIApiKey,
			dangerouslyAllowBrowser: true,
		});

		this.addCommand({
			id: 'buddy-chat',
			name: 'Let\'s have a chat',
			checkCallback: (checking: boolean) => {
				const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView) {
					if (!checking) this.chat(markdownView);
					return true;
				}
			}
		});

		this.registerMarkdownCodeBlockProcessor("buddy", (source, el, ctx) => {
			const callout = el.createEl("div", { cls: "callout" });
			const title = callout.createEl("div", { cls: "callout-title" });
			// const icon = title.createEl("div", { cls: "callout-icon" })
			// icon.createEl("svg" …)
			title.createEl("div", { cls: "callout-title-inner", text: "Buddy" });

			const content = callout.createEl("div", { cls: "callout-content" })
			MarkdownRenderer.render(this.app, source, content, ctx.sourcePath, this)
		});
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private getLinks(file: TFile): { frontmatterLinks: string[], links: string[], backlinks: string[] } {
		const cache = this.app.metadataCache.getFileCache(file);
		const links = cache?.links?.map(l => l.link) || [];
		const frontmatterLinks = cache?.frontmatterLinks?.map(l => l.link) || [];
		// @ts-ignore
		const backlinks = Object.keys(this.app.metadataCache.getBacklinksForFile(file)?.data) || [];
		return { frontmatterLinks, links, backlinks };
	}

	private getLinkedFiles(file: TFile, depth: number = 1): TFile[] {
		console.log('getLinkedFiles', file, depth);
		if (depth < 1) return [];

		const cache = this.app.metadataCache;
		const { frontmatterLinks, links, backlinks } = this.getLinks(file);
		let files = frontmatterLinks.concat(links).concat(backlinks)
			.map(link => cache.getFirstLinkpathDest(link, file.path))
			.filter(f => f != null) as TFile[];
		// Remove duplicates
		files = [...new Set(files)];

		if (depth > 1) {
			files = files.flatMap(f => [f, ...this.getLinkedFiles(f, depth - 1)])
		}

		// Remove duplicates, again
		return [...new Set(files)];
	}

	private chat(markdownView: MarkdownView) {
		const file = markdownView.file!;
		const md = markdownViewToMd(markdownView, true);

		const linkedFiles = this.getLinkedFiles(file, 2);
		new FileSelectionModal(this.app, linkedFiles, selectedFiles => {
			console.log('selectedFiles', selectedFiles);
		}).open();

		const messages = gptMessages(md);

		const fileName = markdownView.file?.name;
		const folder = markdownView.file?.parent?.path;
		const systemPrompt =
			`You are a friendly AI assistant integrated inside of an Obsidian Markdown note named "${fileName}" in folder "${folder}".` +
			" User messages constitute the entire document, interspersed with your own responses." +
			" Feel free to use Markdown in your responses or anything that is compatible with Obsidian or Obsidian plugins.";
		messages.unshift({ role: "system", content: systemPrompt });

		console.log(messages)
		// openai.chat.completions.create({
		// 	messages: messages,
		// 	model: 'gpt-3.5-turbo',
		// }).then((completion) => {
		// 	const message = completion.choices[0].message;
		// 	const messageMd = messageToMd(message);
		// 	console.log(messageMd);

		// 	const editor = markdownView.editor;
		// 	const lastLine = editor.lineCount() - 1;
		// 	const lastCh = editor.getLine(lastLine).length;
		// 	const endPos = { line: lastLine, ch: lastCh };
		// 	console.log(endPos);

		// 	editor.replaceRange("\n" + messageMd, endPos);
		// });
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

class FileSelectionModal extends Modal {

	private files: TFile[];
	private onSubmit: (selectedFiles: TFile[]) => void;

	private fileToggles: Map<TFile, ToggleComponent>;

	constructor(app: App, files: TFile[], onSubmit: (selectedFiles: TFile[]) => void) {
		super(app);
		this.files = files;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		this.fileToggles = new Map();

		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Related files to include" });

		this.addActions(contentEl);

		for (const file of this.files) {
			new Setting(contentEl)
				.setName(file.basename)
				.setTooltip(file.path)
				.addToggle(toggle => {
					this.fileToggles.set(file, toggle);
				});
		}

		this.addActions(contentEl);
	}

	onClose() {
		let { contentEl } = this;
		contentEl.empty();
	}

	private addActions(contentEl: HTMLElement) {
		new Setting(contentEl)
			.addButton(button => button
				.setButtonText("Select All")
				.onClick(_e => {
					for (const [_file, toggle] of this.fileToggles) {
						toggle.setValue(true);
					}
				})
			)
			.addButton(button => button
				.setButtonText("Select None")
				.onClick(_e => {
					for (const [_file, toggle] of this.fileToggles) {
						toggle.setValue(false);
					}
				})
			)
			.addButton(button => button
				.setCta()
				.setButtonText("Submit")
				.onClick(_e => {
					this.close();
					const selectedFiles = [...this.fileToggles]
						.filter(([_file, toggle]) => toggle.getValue())
						.map(([file, _toggle]) => file);
					this.onSubmit(selectedFiles);
				})
			);
	}
}
