// settingsBackup.full.js
// Spicetify extension: manual export/import + before-close autosave + save picker fallback

(async function SettingsBackupExtension() {
    while (
        !window.Spicetify ||
        !Spicetify.showNotification ||
        !Spicetify.Menu ||
        !Spicetify.Platform?.LocalStorageAPI
    ) {
        await new Promise((resolve) => setTimeout(resolve, 300));
    }

    const EXT_ID = "settings-backup";
    const VERSION = 3;

    const KEYS = {
        autosave: `${EXT_ID}:autosave`,
        autosaveMeta: `${EXT_ID}:autosave-meta`,
        config: `${EXT_ID}:config`,
    };

    const DEFAULT_CONFIG = {
        autosaveEnabled: true,
        includeSessionStorage: true,
        includeLocalStorage: true,
        includePlatformStorage: true,
        includeFilteredSpicetifyLocalStorage: true,
        preferSavePicker: true,
    };

    function notify(text, isError = false) {
        try {
            Spicetify.showNotification(text, isError);
        } catch {}
    }

    function getStore() {
        return Spicetify.Platform.LocalStorageAPI;
    }

    function loadConfig() {
        try {
            const raw = getStore().getItem(KEYS.config);
            return { ...DEFAULT_CONFIG, ...(raw || {}) };
        } catch {
            return { ...DEFAULT_CONFIG };
        }
    }

    function saveConfig(cfg) {
        try {
            getStore().setItem(KEYS.config, cfg);
        } catch {}
    }

    let config = loadConfig();
    let isRestoring = false;

    function safeParseJSON(value, fallback = null) {
        try {
            return JSON.parse(value);
        } catch {
            return fallback;
        }
    }

    function cloneStorage(storageObj) {
        const result = {};
        try {
            for (let i = 0; i < storageObj.length; i++) {
                const key = storageObj.key(i);
                if (key == null) continue;
                result[key] = storageObj.getItem(key);
            }
        } catch {}
        return result;
    }

    function getPlatformLocalStorageSnapshot() {
        const result = {};
        try {
            const items = Spicetify.Platform.LocalStorageAPI.items || {};
            for (const [fullKey, value] of Object.entries(items)) {
                result[fullKey] = value;
            }
        } catch {}
        return result;
    }

    function getFilteredSpicetifyLocalStorageSnapshot() {
        const result = {};
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (!key) continue;
                const lower = key.toLowerCase();
                if (
                    lower.startsWith("spicetify") ||
                    lower.startsWith("extensions:") ||
                    lower.startsWith("marketplace:") ||
                    lower.startsWith("settings-backup:") ||
                    lower.includes("spotify:") ||
                    lower.includes("xpui") ||
                    lower.includes("layout") ||
                    lower.includes("sidebar") ||
                    lower.includes("right-sidebar") ||
                    lower.includes("now-playing") ||
                    lower.includes("panel")
                ) {
                    result[key] = localStorage.getItem(key);
                }
            }
        } catch {}
        return result;
    }

    function buildBackupPayload(source = "manual") {
        return {
            format: "spicetify-settings-backup",
            version: VERSION,
            createdAt: new Date().toISOString(),
            source,
            spotifyClientVersion:
                Spicetify.Platform?.version ||
                Spicetify?.version ||
                "unknown",
            configSnapshot: config,
            data: {
                localStorage: config.includeLocalStorage ? cloneStorage(window.localStorage) : {},
                sessionStorage: config.includeSessionStorage ? cloneStorage(window.sessionStorage) : {},
                platformLocalStorage: config.includePlatformStorage ? getPlatformLocalStorageSnapshot() : {},
                filteredSpicetifyLocalStorage: config.includeFilteredSpicetifyLocalStorage
                    ? getFilteredSpicetifyLocalStorageSnapshot()
                    : {},
            },
        };
    }

    function saveAutosaveSnapshot(reason = "autosave") {
        if (isRestoring || !config.autosaveEnabled) return false;

        try {
            const payload = buildBackupPayload(reason);

            const meta = getStore().getItem(KEYS.autosaveMeta) || {
                count: 0,
                history: [],
            };

            meta.count = (meta.count || 0) + 1;
            meta.lastSavedAt = payload.createdAt;
            meta.lastReason = reason;
            meta.history = Array.isArray(meta.history) ? meta.history : [];
            meta.history.unshift({
                at: payload.createdAt,
                reason,
            });
            meta.history = meta.history.slice(0, 20);

            getStore().setItem(KEYS.autosave, payload);
            getStore().setItem(KEYS.autosaveMeta, meta);
            return true;
        } catch (err) {
            console.error(`[${EXT_ID}] Autosave failed`, err);
            return false;
        }
    }

    function restoreStorageObject(storageObj, dataObj, clearFirst = false) {
        if (!dataObj || typeof dataObj !== "object") return;

        if (clearFirst) {
            try {
                storageObj.clear();
            } catch {}
        }

        for (const [key, value] of Object.entries(dataObj)) {
            try {
                storageObj.setItem(key, value);
            } catch {}
        }
    }

    function restorePlatformLocalStorage(dataObj) {
        if (!dataObj || typeof dataObj !== "object") return;

        const store = getStore();
        const namespace = store.namespace || "";

        for (const [fullKey, value] of Object.entries(dataObj)) {
            try {
                let logicalKey = fullKey;
                if (namespace && fullKey.startsWith(`${namespace}:`)) {
                    logicalKey = fullKey.slice(namespace.length + 1);
                }
                store.setItem(logicalKey, value);
            } catch {}
        }
    }

    function validateBackupFile(obj) {
        return (
            obj &&
            typeof obj === "object" &&
            obj.format === "spicetify-settings-backup" &&
            typeof obj.version === "number" &&
            obj.data &&
            typeof obj.data === "object"
        );
    }

    async function importBackupObject(obj, sourceName = "backup.json") {
        if (!validateBackupFile(obj)) {
            notify("Érvénytelen backup fájl.", true);
            return;
        }

        try {
            isRestoring = true;

            restoreStorageObject(window.localStorage, obj.data.localStorage || {}, false);
            restoreStorageObject(window.sessionStorage, obj.data.sessionStorage || {}, true);
            restorePlatformLocalStorage(obj.data.platformLocalStorage || {});
            restoreStorageObject(window.localStorage, obj.data.filteredSpicetifyLocalStorage || {}, false);

            saveAutosaveSnapshot("post-import");
            notify(`Backup betöltve: ${sourceName}. Spotify újraindítás ajánlott.`);
        } catch (err) {
            console.error(`[${EXT_ID}] Import failed`, err);
            notify("A backup importálása nem sikerült.", true);
        } finally {
            isRestoring = false;
        }
    }

    async function restoreLatestAutosave() {
        try {
            const autosave = getStore().getItem(KEYS.autosave);
            if (!autosave) {
                notify("Nincs autosave mentés.", true);
                return;
            }
            await importBackupObject(autosave, "latest autosave");
        } catch (err) {
            console.error(`[${EXT_ID}] Restore latest autosave failed`, err);
            notify("Az autosave visszatöltése nem sikerült.", true);
        }
    }

    async function exportWithSavePicker(payload, filename) {
        if (!window.showSaveFilePicker) {
            throw new Error("showSaveFilePicker not supported");
        }

        const handle = await window.showSaveFilePicker({
            suggestedName: filename,
            types: [
                {
                    description: "JSON Backup",
                    accept: {
                        "application/json": [".json"],
                    },
                },
            ],
        });

        const writable = await handle.createWritable();
        await writable.write(JSON.stringify(payload, null, 2));
        await writable.close();
    }

    function exportWithDownload(payload, filename) {
        const blob = new Blob([JSON.stringify(payload, null, 2)], {
            type: "application/json",
        });

        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 3000);
    }

    async function exportBackupNow() {
        try {
            const payload = buildBackupPayload("manual-export");
            const date = new Date().toISOString().replace(/[:.]/g, "-");
            const filename = `spotify-settings-backup-${date}.json`;

            if (config.preferSavePicker && window.showSaveFilePicker) {
                try {
                    await exportWithSavePicker(payload, filename);
                    notify("Backup elmentve a kiválasztott helyre.");
                    return;
                } catch (pickerErr) {
                    console.warn(`[${EXT_ID}] Save picker failed, falling back to download`, pickerErr);
                }
            }

            exportWithDownload(payload, filename);
            notify("Backup exportálva letöltésként.");
        } catch (err) {
            console.error(`[${EXT_ID}] Export failed`, err);
            notify("A backup exportálása nem sikerült.", true);
        }
    }

    function importBackupFromFile() {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "application/json,.json";

        input.addEventListener("change", async () => {
            const file = input.files?.[0];
            if (!file) return;

            try {
                const text = await file.text();
                const obj = safeParseJSON(text);
                await importBackupObject(obj, file.name);
            } catch (err) {
                console.error(`[${EXT_ID}] File import failed`, err);
                notify("A fájl beolvasása nem sikerült.", true);
            }
        });

        input.click();
    }

    function manualAutosaveNow() {
        const ok = saveAutosaveSnapshot("manual-autosave");
        if (ok) notify("Autosave snapshot létrehozva.");
        else notify("Az autosave snapshot nem sikerült.", true);
    }

    function toggleAutosave(self) {
        config.autosaveEnabled = !config.autosaveEnabled;
        saveConfig(config);
        self.setState(config.autosaveEnabled);
        notify(
            config.autosaveEnabled
                ? "Automatikus mentés bekapcsolva."
                : "Automatikus mentés kikapcsolva."
        );
    }

    function toggleSavePicker(self) {
        config.preferSavePicker = !config.preferSavePicker;
        saveConfig(config);
        self.setState(config.preferSavePicker);
        notify(
            config.preferSavePicker
                ? "Mentési hely választó előnyben részesítve."
                : "Mentési hely választó kikapcsolva, sima letöltés lesz."
        );
    }

    function showStatus() {
        try {
            const meta = getStore().getItem(KEYS.autosaveMeta);
            if (!meta) {
                notify("Nincs még autosave snapshot.");
                return;
            }

            const text =
                `Autosave: ${config.autosaveEnabled ? "ON" : "OFF"} | ` +
                `Mentési hely választó: ${config.preferSavePicker ? "ON" : "OFF"} | ` +
                `Utolsó mentés: ${meta.lastSavedAt || "nincs"} | ` +
                `Ok: ${meta.lastReason || "ismeretlen"}`;

            notify(text);
        } catch {
            notify("A státusz lekérése nem sikerült.", true);
        }
    }

    function registerMenus() {
        const autosaveToggle = new Spicetify.Menu.Item(
            "Settings Backup: Autosave",
            config.autosaveEnabled,
            toggleAutosave
        );

        const savePickerToggle = new Spicetify.Menu.Item(
            "Settings Backup: Prefer Save Picker",
            config.preferSavePicker,
            toggleSavePicker
        );

        const exportItem = new Spicetify.Menu.Item(
            "Settings Backup: Export Backup",
            false,
            exportBackupNow
        );

        const importItem = new Spicetify.Menu.Item(
            "Settings Backup: Import Backup",
            false,
            importBackupFromFile
        );

        const restoreLatestItem = new Spicetify.Menu.Item(
            "Settings Backup: Restore Latest Autosave",
            false,
            restoreLatestAutosave
        );

        const saveNowItem = new Spicetify.Menu.Item(
            "Settings Backup: Create Autosave Now",
            false,
            manualAutosaveNow
        );

        const statusItem = new Spicetify.Menu.Item(
            "Settings Backup: Show Status",
            false,
            showStatus
        );

        const submenu = new Spicetify.Menu.SubMenu("Settings Backup", [
            autosaveToggle,
            savePickerToggle,
            exportItem,
            importItem,
            restoreLatestItem,
            saveNowItem,
            statusItem,
        ], getBackupMenuIcon());

        submenu.register();
    }

    function getBackupMenuIcon() {
        return `
            <svg height="16" width="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M2 1.5h9.7L14.5 4.3v10.2h-13v-13Zm1.5 1.5v10h9.5V4.9L11.1 3H10v4H4V3H3.5Zm2 0v2.5h3V3h-3Zm-.5 7h6v3H5v-3Z"></path>
            </svg>
        `;
    }

    registerMenus();

    saveAutosaveSnapshot("startup");
    window.addEventListener("beforeunload", () => {
        saveAutosaveSnapshot("beforeunload");
    });

    notify("Settings Backup betöltve.");
})();
