import { Menu, setIcon, ItemView, Setting, ExtraButtonComponent } from "obsidian";
import { t } from "src/translations/helper";
import type editingToolbarPlugin from "src/plugin/main";
import { CommandPicker, openSlider } from "src/modals/suggesterModals";
import { selfDestruct } from "src/modals/editingToolbarModal";
import { setMenuVisibility } from "src/util/statusBarConstants";
import { ViewUtils } from "src/util/viewUtils";
import { AESTHETIC_STYLES } from "src/settings/settingsData";

const TOOLBAR_TOGGLES = [
  { style: "top", title: "Top Toolbar", key: "enableTopToolbar" },
  { style: "following", title: "Following Toolbar", key: "enableFollowingToolbar" },
  { style: "fixed", title: "Fixed Toolbar", key: "enableFixedToolbar" },
] as const;

// 默认允许显示工具栏的视图类型
const DEFAULT_VIEW_TYPES = [
  'markdown',
  'canvas',
  'thino_view',
  'meld-encrypted-view',
];

/**
 * Status bar button with a quick-settings panel.
 * A panel rather than a Menu: Obsidian closes a menu (native or not) after every
 * click, which made changing several toggles in a row tedious.
 */
export class StatusBar {
  private plugin: editingToolbarPlugin;
  private statusBarIcon: HTMLElement;
  private panelEl: HTMLElement | null = null;
  private panelCleanup: (() => void) | null = null;

  constructor(plugin: editingToolbarPlugin) {
    this.plugin = plugin;
  }

  public init(): void {
    this.statusBarIcon = this.plugin.addStatusBarItem();
    this.statusBarIcon.addClass("editingToolbar-statusbar-button");
    setIcon(this.statusBarIcon, "editingToolbar");
    this.statusBarIcon.setAttr("data-tooltip-position", "top");
    this.updateTooltip();
    this.plugin.registerDomEvent(this.statusBarIcon, "click", () => {
      if (this.panelEl) this.closePanel();
      else this.openPanel();
    });
    this.plugin.register(() => this.closePanel());
  }

  /**
   * Called from saveSettings(): the state can change from settings, commands or
   * this panel. Refreshing on hover is too late, as Obsidian reads the label on
   * mouseover, which fires before mouseenter.
   */
  public updateTooltip(): void {
    this.statusBarIcon?.setAttr("aria-label", this.getTooltip());
  }

  /** Tooltip summarising the current state, so it is visible without opening the panel. */
  private getTooltip(): string {
    const s = this.plugin.settings;
    if (!s.cMenuVisibility) {
      return `${t("Editing Toolbar")}: ${t("Hidden")}`;
    }
    const enabled = TOOLBAR_TOGGLES.filter(({ key }) => s[key]).map(({ style, title }) =>
      // Auto-hide only applies to the top toolbar and makes it fully transparent until hovered.
      style === "top" && s.autohide ? `${t(title)} (${t("auto-hide")})` : t(title));
    return `${t("Editing Toolbar")}: ${enabled.length ? enabled.join(", ") : t("No toolbar enabled")}`;
  }

  private openPanel(): void {
    const doc = this.statusBarIcon.doc;
    const win = this.statusBarIcon.win;
    const panel = this.panelEl = doc.body.createDiv({ cls: "editingToolbar-quick-settings" });
    this.statusBarIcon.addClass("is-active");

    // Anchor above the status bar, right-aligned with the button.
    const iconRect = this.statusBarIcon.getBoundingClientRect();
    const barRect = (this.statusBarIcon.parentElement ?? this.statusBarIcon).getBoundingClientRect();
    panel.setCssStyles({
      right: `${Math.max(8, win.innerWidth - iconRect.right)}px`,
      bottom: `${win.innerHeight - barRect.top + 6}px`,
    });

    this.renderPanel();

    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // Clicks on the button toggle via its own handler; menus opened from the panel live outside it.
      if (panel.contains(target) || this.statusBarIcon.contains(target)) return;
      if (target.instanceOf(HTMLElement) && target.closest(".menu")) return;
      this.closePanel();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.closePanel();
    };
    doc.addEventListener("mousedown", onMouseDown, true);
    doc.addEventListener("keydown", onKeyDown, true);
    this.panelCleanup = () => {
      doc.removeEventListener("mousedown", onMouseDown, true);
      doc.removeEventListener("keydown", onKeyDown, true);
    };
  }

  private closePanel(): void {
    this.panelCleanup?.();
    this.panelCleanup = null;
    this.panelEl?.remove();
    this.panelEl = null;
    this.statusBarIcon?.removeClass("is-active");
  }

  /** Re-render after each change so dependent rows (auto-hide, view state) stay in sync. */
  private renderPanel(): void {
    const panel = this.panelEl;
    if (!panel) return;
    panel.empty();
    const s = this.plugin.settings;

    const header = panel.createDiv({ cls: "editingToolbar-quick-settings-header" });
    header.createSpan({ text: t("Editing Toolbar") });
    new ExtraButtonComponent(header)
      .setIcon("settings")
      .setTooltip(t("Settings"))
      .onClick(() => {
        this.closePanel();
        this.plugin.app.setting.open();
        this.plugin.app.setting.openTabById("editing-toolbar");
      });

    // 显示 / 隐藏
    const visibilitySection = this.createSection(panel);
    new Setting(visibilitySection)
      .setName(t("Show Toolbar"))
      .addToggle((toggle) => toggle
        .setValue(s.cMenuVisibility)
        .onChange(async (value) => {
          s.cMenuVisibility = value;
          value
            ? window.setTimeout(() => {
              dispatchEvent(new Event("editingToolbar-NewCommand"));
            }, 100)
            : setMenuVisibility(value);
          selfDestruct(this.plugin);
          await this.plugin.saveSettings();
          this.renderPanel();
        }));

    // 工具栏开关
    const toolbarSection = this.createSection(panel);
    toolbarSection.toggleClass("is-muted", !s.cMenuVisibility);
    TOOLBAR_TOGGLES.forEach(({ style, title, key }) => {
      new Setting(toolbarSection)
        .setName(t(title))
        .addToggle((toggle) => toggle
          .setValue(s[key] || false)
          .onChange(async (value) => {
            const prevStyle = this.plugin.positionStyle;
            s[key] = value;
            let nextStyle: string | null = null;
            if (value) {
              nextStyle = style;
            } else if (prevStyle === style) {
              nextStyle = TOOLBAR_TOGGLES.find((other) => s[other.key])?.style ?? null;
            }
            if (nextStyle && nextStyle !== prevStyle) {
              this.plugin.onPositionStyleChange(nextStyle);
            }
            await this.plugin.saveSettings();
            this.plugin.handleeditingToolbar();
            this.renderPanel();
          }));

      if (style === "top" && s.enableTopToolbar) {
        new Setting(toolbarSection)
          .setName(t("Auto-hide"))
          .setClass("editingToolbar-quick-settings-sub")
          .addToggle((toggle) => toggle
            .setValue(s.autohide)
            .onChange(async (value) => {
              s.autohide = value;
              await this.plugin.saveSettings();
              window.setTimeout(() => {
                dispatchEvent(new Event("editingToolbar-NewCommand"));
              }, 100);
            }));
      }
    });

    // 外观样式
    const appearanceSection = this.createSection(panel);
    new Setting(appearanceSection)
      .setName(t("Appearance Style"))
      .addDropdown((dropdown) => dropdown
        .addOptions(Object.fromEntries(AESTHETIC_STYLES.map((style) => [style, style])))
        .setValue(s.aestheticStyle)
        .onChange(async (value) => {
          s.aestheticStyle = value;
          await this.plugin.saveSettings();
          selfDestruct(this.plugin);
          window.setTimeout(() => {
            dispatchEvent(new Event("editingToolbar-NewCommand"));
          }, 100);
        }));

    // 当前视图
    const view = this.plugin.app.workspace.getActiveViewOfType(ItemView);
    if (view) {
      const viewType = view.getViewType();
      const viewSection = this.createSection(panel);
      new Setting(viewSection)
        .setName(t("Current View: ") + viewType)
        .addExtraButton((button) => button
          .setIcon("settings-2")
          .setTooltip(t("Manage all view types"))
          .onClick(() => this.showViewTypesMenu(button.extraSettingsEl, viewType)))
        .addToggle((toggle) => toggle
          .setValue(ViewUtils.isAllowedViewType(view))
          .onChange(async (value) => {
            if (!s.viewTypeSettings) s.viewTypeSettings = {};
            s.viewTypeSettings[viewType] = value;
            await this.plugin.saveSettings();
            selfDestruct(this.plugin);
            window.setTimeout(() => {
              dispatchEvent(new Event("editingToolbar-NewCommand"));
            }, 100);
          }));
    }

    // 操作
    const controlsSection = this.createSection(panel);
    const controls = new Setting(controlsSection).setClass("editingToolbar-quick-settings-controls");
    controls.addButton((button) => button
      .setIcon("plus")
      .setButtonText(t("Add Command"))
      .onClick(() => {
        this.closePanel();
        new CommandPicker(this.plugin).open();
      }));
    if (s.enableFixedToolbar || this.plugin.positionStyle === "fixed") {
      controls.addButton((button) => button
        .setIcon("file-sliders")
        .setButtonText(t("Position Settings"))
        .onClick(() => {
          this.closePanel();
          new openSlider(this.plugin.app, this.plugin).open();
        }));
    }
  }

  private createSection(panel: HTMLElement): HTMLElement {
    return panel.createDiv({ cls: "editingToolbar-quick-settings-section" });
  }

  private showViewTypesMenu(anchorEl: HTMLElement, currentViewType: string): void {
    const s = this.plugin.settings;
    const knownViewTypes = new Set([
      ...DEFAULT_VIEW_TYPES,
      ...Object.keys(s.viewTypeSettings || {}),
    ]);
    const menu = new Menu();
    Array.from(knownViewTypes).sort().forEach((vType) => {
      const isViewAllowed = this.isViewTypeAllowed(vType);
      menu.addItem((item) => item
        .setTitle(vType)
        .setChecked(isViewAllowed)
        .onClick(async () => {
          if (!s.viewTypeSettings) s.viewTypeSettings = {};
          s.viewTypeSettings[vType] = !isViewAllowed;
          // 如果当前视图就是这个类型，则刷新工具栏
          if (vType === currentViewType) {
            selfDestruct(this.plugin);
            window.setTimeout(() => {
              dispatchEvent(new Event("editingToolbar-NewCommand"));
            }, 100);
          }
          await this.plugin.saveSettings();
          this.renderPanel();
        }));
    });
    const rect = anchorEl.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom });
  }

  // 检查视图类型是否允许显示工具栏
  private isViewTypeAllowed(viewType: string): boolean {
    const setting = this.plugin.settings.viewTypeSettings?.[viewType];
    // 如果没有专门的设置，使用默认值
    return setting === undefined ? DEFAULT_VIEW_TYPES.includes(viewType) : setting;
  }
}
