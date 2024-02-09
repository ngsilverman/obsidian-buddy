import { App, MarkdownRenderer, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, ToggleComponent } from 'obsidian';
import OpenAI from "openai";
import { ChatCompletionMessageParam } from 'openai/resources';

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

interface Message extends ChatCompletionMessageParam {
}

interface LinkedFile {
	file: TFile;
	/* 1 means it's a direct link, 2 means it's a second degree link (link from a direct link), etc. */
	degree: number;
}

function groupBy(array: any[], key: any): Map<any, any> {
	return array.reduce((result: Map<any, any>, currentValue) => {
		const groupKey = currentValue[key];
		if (!result.has(groupKey)) {
			result.set(groupKey, []);
		}
		result.get(groupKey).push(currentValue);
		return result;
	}, new Map());
}

function getSnippet(fileContent: string, maxLength: number = 100): string {
	let result = '';
	const reverseLines = fileContent.trim().split("\n").reverse();
	for (const line of reverseLines) {
		if (line.length + result.length > maxLength) {
			result = "[…]\n" + result;
			break;
		}
		result = line + "\n" + result;
	}
	return result;
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

	private openai: OpenAI;

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new BuddySettingTab(this.app, this));

		// TODO: Check that an API key has been set.
		this.openai = new OpenAI({
			apiKey: this.settings.openAIApiKey,
			dangerouslyAllowBrowser: true,
		});

		this.addCommand({
			id: 'buddy-chat',
			name: 'Let\'s have a chat',
			checkCallback: (checking: boolean) => {
				const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView) {
					if (!checking) this.prechat(markdownView);
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

	private getLinkedFiles(file: TFile, depth: number = 1, ignore: TFile[] = [], degree: number = 1): LinkedFile[] {
		if (depth < 1) return [];

		// Don't include the file itself in the links.
		ignore.push(file);

		const cache = this.app.metadataCache;
		const { frontmatterLinks, links, backlinks } = this.getLinks(file);
		let files = (frontmatterLinks.concat(links).concat(backlinks)
			.map(link => cache.getFirstLinkpathDest(link, file.path))
			.filter(f => f != null) as TFile[])
			.unique()
			.filter(f => !ignore.includes(f));

		// Avoid duplicates.
		ignore = ignore.concat(files);

		let linkedFiles = files.map(file => {
			return { file, degree }
		});

		if (depth > 1) {
			linkedFiles = linkedFiles.flatMap(lf => [lf, ...this.getLinkedFiles(lf.file, depth - 1, ignore, degree + 1)])
		}

		return linkedFiles;
	}

	private async generateSystemPrompt(selectedFiles: LinkedFile[]): Promise<string> {
		let prompt = "Here are some files related to the user's request:\n";
		for (const { file } of selectedFiles) {
			prompt += "\n---FILE: " + file.name + "---\n" + await this.app.vault.cachedRead(file);
		}
		return prompt;
	}

	private prechat(markdownView: MarkdownView) {
		const activeFile = markdownView.file!;
		const linkedFiles = this.getLinkedFiles(activeFile, 2);
		new FileSelectionModal(this.app, activeFile, linkedFiles, selectedFiles => {
			this.chat(markdownView, selectedFiles);
		}).open();
	}

	private async chat(markdownView: MarkdownView, selectedFiles: LinkedFile[]) {
		// TODO Include properties from the active file somehow
		const md = markdownViewToMd(markdownView);
		const messages = gptMessages(md);

		// const systemPrompt =
			// `You are a friendly AI assistant integrated inside of an Obsidian Markdown note named "${fileName}" in folder "${folder}".` +
			// " User messages constitute the entire document, interspersed with your own responses." +
			// " Feel free to use Markdown in your responses or anything that is compatible with Obsidian or Obsidian plugins.";
		messages.unshift({ role: "system", content: await this.generateSystemPrompt(selectedFiles) });

		// TODO Add some kind of loading indicator

		this.openai.chat.completions.create({
			messages: messages,
			model: 'gpt-3.5-turbo',
		}).then((completion) => {
			const message = completion.choices[0].message;
			const messageMd = messageToMd(message);

			const editor = markdownView.editor;
			const lastLine = editor.lineCount() - 1;
			const lastCh = editor.getLine(lastLine).length;
			const endPos = { line: lastLine, ch: lastCh };

			editor.replaceRange("\n" + messageMd, endPos);
		});
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

	private activeFile: TFile;
	private linkedFiles: LinkedFile[];
	private onSubmit: (selectedFiles: LinkedFile[]) => void;

	private fileToggles: Map<LinkedFile, ToggleComponent>;

	constructor(
		app: App,
		activeFile: TFile,
		linkedFiles: LinkedFile[],
		onSubmit: (selectedFiles: LinkedFile[]) => void
	) {
		super(app);
		this.activeFile = activeFile;
		this.linkedFiles = linkedFiles;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		this.fileToggles = new Map();

		const { contentEl } = this;
		contentEl.addClass('buddy-modal');

		// TODO What if it's not a text file?

		const activeFileEl = contentEl.createDiv();
		this.app.vault.cachedRead(this.activeFile)
			.then(content => {
				MarkdownRenderer.render(
					this.app,
					"The content of the active file, _" + this.activeFile.basename + "_, will be"
					+ " included at the end of the prompt. This is the last thing the AI will read"
					+ " before generating a response:\n```\n" + getSnippet(content, 100) + "\n```",
					activeFileEl,
					this.activeFile.path,
					// @ts-ignore
					null
				);
			});

		contentEl.createEl('p', { text: "Files from the local graph can also be included as additional context:" });

		const fileGroups = groupBy(this.linkedFiles, "degree");

		for (const [degree, files] of fileGroups) {
			new Setting(contentEl)
				.setName(fileGroups.size > 1 ? `Degree ${degree}` : '')
				.setClass("setting-item-heading")
				.then(setting => {
					const selectEl = setting.controlEl.createDiv({ text: "Select ", cls: "buddy-select-shortcut" });
					selectEl.createEl("a", { text: "All" }, el => {
						el.onClickEvent((_ev) => this.setToggleValues(true, lf => lf.degree === degree));
					});
					selectEl.appendText(" | ");
					selectEl.createEl("a", { text: "None" }, el => {
						el.onClickEvent((_ev) => this.setToggleValues(false, lf => lf.degree === degree));
					});

				});

			for (const lf of files) {
				new Setting(contentEl)
					.setName(lf.file.basename)
					.setTooltip(lf.file.path)
					.addToggle(toggle => {
						this.fileToggles.set(lf, toggle);
					});
			}
		}

		new Setting(contentEl)
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

	onClose() {
		let { contentEl } = this;
		contentEl.empty();
	}

	private setToggleValues(value: boolean, predicate: (linkedFile: LinkedFile) => boolean) {
		for (const [file, toggle] of this.fileToggles) {
			if (predicate(file)) {
				toggle.setValue(value);
			}
		}
	}
}
