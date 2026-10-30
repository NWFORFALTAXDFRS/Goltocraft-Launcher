const remoteMain = require('@electron/remote/main')
remoteMain.initialize()

// Requirements
const { app, BrowserWindow, ipcMain, Menu, shell, net } = require('electron')
const autoUpdater                       = require('electron-updater').autoUpdater
const ejse                              = require('ejs-electron')
const fs                                = require('fs')
const https                             = require('https')
const os                                = require('os')
const { spawn }                         = require('child_process')
const isDev                             = require('./app/assets/js/isdev')
const path                              = require('path')
const semver                            = require('semver')
const { pathToFileURL }                 = require('url')
const { AZURE_CLIENT_ID, MSFT_OPCODE, MSFT_REPLY_TYPE, MSFT_ERROR, SHELL_OPCODE } = require('./app/assets/js/ipcconstants')
const LangLoader                        = require('./app/assets/js/langloader')

// Setup Lang
LangLoader.setupLanguage()

// Setup auto updater - Goltocraft 1.0.81
let goltoUpdaterInitialized = false
let goltoUpdateChecking = false
let goltoUpdateDownloading = false
let goltoUpdateDownloaded = false
let goltoUpdateDownloadedVersion = null
let goltoUpdateSender = null
let goltoReinstallDownloading = false
let goltoReinstallInstallerPath = null
let goltoElectronUpdateReady = false

function goltoSendUpdateStatus(type, info) {
    try {
        if(goltoUpdateSender && !goltoUpdateSender.isDestroyed()) {
            goltoUpdateSender.send('autoUpdateNotification', type, info)
        }
    } catch(err) {
        console.error('[Goltocraft Updater] UI notification error:', err)
    }
}

function initAutoUpdater(event, data) {
    goltoUpdateSender = event.sender
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true

    // Goltocraft 1.0.105 : detection automatique, telechargement au clic du bouton.
    autoUpdater.allowPrerelease = false
    if(isDev) autoUpdater.updateConfigPath = path.join(__dirname, 'dev-app-update.yml')

    // Important: register updater listeners only once.
    if(goltoUpdaterInitialized) return
    goltoUpdaterInitialized = true

    autoUpdater.on('checking-for-update', () => {
        goltoUpdateChecking = true
        goltoSendUpdateStatus('checking-for-update')
    })
    autoUpdater.on('update-available', (info) => {
        goltoUpdateChecking = false
        // La mise a jour est disponible : le bouton Telecharger reste cliquable.
        goltoUpdateDownloading = false
        goltoSendUpdateStatus('update-available', info)
    })
    autoUpdater.on('update-not-available', (info) => {
        goltoUpdateChecking = false
        goltoUpdateDownloading = false
        goltoSendUpdateStatus('update-not-available', info)
    })
    autoUpdater.on('download-progress', (progress) => {
        goltoUpdateChecking = false
        goltoUpdateDownloading = true
        goltoSendUpdateStatus('download-progress', progress)
    })
    autoUpdater.on('update-downloaded', (info) => {
        goltoUpdateChecking = false
        goltoUpdateDownloading = false
        goltoUpdateDownloaded = true
        goltoUpdateDownloadedVersion = info && info.version ? info.version : goltoUpdateDownloadedVersion
        goltoElectronUpdateReady = true
        goltoSendUpdateStatus('update-downloaded', info)
    })
    autoUpdater.on('error', (err) => {
        goltoUpdateChecking = false
        goltoUpdateDownloading = false
        goltoSendUpdateStatus('realerror', err)
    })
}

function goltoGetLatestGitHubRelease() {
    // 1.0.130: Public Versions Goltocraft peut publier une release qui n'est pas
    // encore reflétée immédiatement par /releases/latest. On lit les releases
    // publiées et on choisit la plus grande version SemVer non brouillon.
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.github.com',
            path: '/repos/NWFORFALTAXDFRS/Goltocraft-Launcher/releases?per_page=20&_=' + Date.now(),
            method: 'GET',
            headers: {
                'User-Agent': 'Goltocraft-Launcher-Updater-1.0.136',
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'Cache-Control': 'no-cache, no-store, max-age=0',
                'Pragma': 'no-cache'
            }
        }
        const req = https.request(options, res => {
            let body = ''
            res.setEncoding('utf8')
            res.on('data', chunk => body += chunk)
            res.on('end', () => {
                if(res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`GitHub releases HTTP ${res.statusCode}`))
                    return
                }
                try {
                    const releases = JSON.parse(body)
                    if(!Array.isArray(releases)) throw new Error('Réponse GitHub invalide')
                    const candidates = releases
                        .filter(r => r && !r.draft)
                        .map(r => ({
                            version: String(r.tag_name || r.name || '').trim().replace(/^v/i, ''),
                            release: r
                        }))
                        .filter(x => semver.valid(x.version))
                        .sort((a,b) => semver.rcompare(a.version, b.version))
                    if(candidates.length === 0) throw new Error('Aucune release Goltocraft publiée avec une version valide')
                    resolve(candidates[0])
                } catch(err) { reject(err) }
            })
        })
        req.setTimeout(12000, () => req.destroy(new Error('GitHub timeout')))
        req.on('error', reject)
        req.end()
    })
}
async function goltoGetPreparingGitHubRelease() {
    // Public Versions Goltocraft publie temporairement un prerelease
    // vX.Y.Z-preparing dès son démarrage. Il sert uniquement à afficher
    // l'état jaune "version suivante en préparation" dans les launchers ouverts.
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.github.com',
            path: '/repos/NWFORFALTAXDFRS/Goltocraft-Launcher/releases?per_page=20&_=' + Date.now(),
            method: 'GET',
            headers: {
                'User-Agent': 'Goltocraft-Launcher-Updater-Preparing',
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'Cache-Control': 'no-cache, no-store, max-age=0',
                'Pragma': 'no-cache'
            }
        }
        const req = https.request(options, res => {
            let body = ''
            res.setEncoding('utf8')
            res.on('data', c => body += c)
            res.on('end', () => {
                if(res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`GitHub releases HTTP ${res.statusCode}`))
                try {
                    const releases = JSON.parse(body)
                    const candidates = (Array.isArray(releases) ? releases : [])
                        .filter(r => r && !r.draft && r.prerelease && (/-preparing$/i.test(String(r.tag_name || '')) || /^goltocraft-preparing-v/i.test(String(r.tag_name || ''))))
                        .map(r => {
                            const tag = String(r.tag_name || '')
                            const version = /^goltocraft-preparing-v/i.test(tag)
                                ? tag.replace(/^goltocraft-preparing-v/i, '')
                                : tag.replace(/^v/i,'').replace(/-preparing$/i,'')
                            return { version, release:r }
                        })
                        .filter(x => semver.valid(x.version))
                        .sort((a,b) => semver.rcompare(a.version,b.version))
                    resolve(candidates[0] || null)
                } catch(e) { reject(e) }
            })
        })
        req.setTimeout(12000, () => req.destroy(new Error('GitHub timeout')))
        req.on('error', reject)
        req.end()
    })
}

async function goltoCheckForUpdates(event) {
    goltoUpdateSender = event.sender
    // 1.0.160 : GitHub est la source de vérité. On compare la release publique
    // ET l'éventuelle release -preparing, puis on choisit l'état le plus avancé.
    // Une ancienne release -preparing ne peut donc plus masquer une vraie mise à jour.
    if(goltoUpdateDownloading || goltoUpdateChecking) return
    goltoUpdateChecking = true
    goltoSendUpdateStatus('checking-for-update')

    let githubOutdated = false
    try {
        const [latest, preparing] = await Promise.all([
            goltoGetLatestGitHubRelease(),
            goltoGetPreparingGitHubRelease().catch(() => null)
        ])
        const current = app.getVersion()
        const stableVersion = latest && semver.valid(latest.version) ? latest.version : null
        const preparingVersion = preparing && semver.valid(preparing.version) ? preparing.version : null

        const stableNewer = !!(stableVersion && semver.valid(current) && semver.gt(stableVersion, current))
        const preparingNewer = !!(preparingVersion && semver.valid(current) && semver.gt(preparingVersion, current))

        if(stableNewer) {
            githubOutdated = true
            const assets = Array.isArray(latest.release && latest.release.assets) ? latest.release.assets : []
            const installerAsset = goltoFindInstallerAsset(latest.release, stableVersion)
            const metadataAsset = assets.find(a => /^latest\.yml$/i.test(String(a && a.name || '')))

            // Si la release publique existe déjà mais ses fichiers ne sont pas encore
            // complètement uploadés, elle est jaune. Dès Setup.exe + latest.yml présents,
            // elle devient rouge automatiquement, sans redémarrer le launcher.
            if(!installerAsset || !metadataAsset) {
                goltoSendUpdateStatus('github-update-preparing', {
                    version: stableVersion,
                    currentVersion: current,
                    publicRelease: true
                })
            } else {
                goltoSendUpdateStatus('github-update-available', {
                    version: stableVersion,
                    currentVersion: current,
                    total: Number(installerAsset.size) > 0 ? Number(installerAsset.size) : 0,
                    automaticDownload: true
                })
            }
        } else if(preparingNewer) {
            goltoSendUpdateStatus('github-update-preparing', {
                version: preparingVersion,
                currentVersion: current,
                prerelease: true
            })
        } else {
            goltoSendUpdateStatus('github-up-to-date', {
                version: current,
                latestVersion: stableVersion || current
            })
        }
    } catch(err) {
        console.error('[Goltocraft Updater] GitHub version check failed:', err)
        goltoSendUpdateStatus('github-check-error', { message: err.message })
    }

    // electron-updater reste disponible pour l'installation NSIS, mais GitHub
    // garde la priorité pour l'état visuel vert/jaune/rouge.
    try {
        await autoUpdater.checkForUpdates()
    } catch(err) {
        console.error('[Goltocraft Updater] electron-updater check failed:', err)
        if(!githubOutdated) goltoSendUpdateStatus('realerror', err)
    } finally {
        goltoUpdateChecking = false
    }
}


// Goltocraft 1.0.104: permet aussi de retélécharger/réinstaller la release publique actuelle.
function goltoDownloadUrl(url, destination, onProgress, redirects = 0, expectedTotal = 0) {
    // 1.0.146: use Electron/Chromium networking instead of Node https.
    // GitHub release assets are served through redirects/CDN endpoints; Chromium's
    // network stack handles those reliably in the packaged launcher.
    return new Promise((resolve, reject) => {
        let settled = false
        let out = null
        let watchdog = null

        const cleanupPartial = () => {
            try { if(out) out.destroy() } catch(e) {}
            try { if(fs.existsSync(destination)) fs.unlinkSync(destination) } catch(e) {}
        }
        const fail = (err) => {
            if(settled) return
            settled = true
            if(watchdog) clearTimeout(watchdog)
            cleanupPartial()
            reject(err instanceof Error ? err : new Error(String(err)))
        }
        const armWatchdog = (req) => {
            if(watchdog) clearTimeout(watchdog)
            watchdog = setTimeout(() => {
                try { req.abort() } catch(e) {}
                fail(new Error('Aucune donnée reçue depuis GitHub pendant 45 secondes'))
            }, 45000)
        }

        let request
        try {
            request = net.request({
                method: 'GET',
                url,
                redirect: 'follow'
            })
            request.setHeader('User-Agent', 'Goltocraft-Launcher-Updater/1.0')
            request.setHeader('Accept', 'application/octet-stream')
            request.setHeader('Cache-Control', 'no-cache')
        } catch(err) {
            return fail(err)
        }

        request.on('response', response => {
            const code = Number(response.statusCode || 0)
            if(code < 200 || code >= 300) {
                try { response.resume() } catch(e) {}
                return fail(new Error(`Téléchargement HTTP ${code}`))
            }

            const headerTotal = Number(response.headers && response.headers['content-length'] || 0)
            const total = headerTotal > 0 ? headerTotal : Number(expectedTotal || 0)
            let transferred = 0
            out = fs.createWriteStream(destination)
            onProgress({ percent: 0, transferred: 0, total })
            armWatchdog(request)

            response.on('data', chunk => {
                armWatchdog(request)
                transferred += chunk.length
                const percent = total > 0 ? Math.min(100, (transferred / total) * 100) : 0
                onProgress({ percent, transferred, total })
            })
            response.on('error', fail)
            out.on('error', fail)
            out.on('finish', () => {
                out.close(() => {
                    if(settled) return
                    settled = true
                    if(watchdog) clearTimeout(watchdog)
                    const finalTotal = total || transferred
                    onProgress({ percent: 100, transferred, total: finalTotal })
                    resolve(destination)
                })
            })
            response.pipe(out)
        })
        request.on('error', fail)
        armWatchdog(request)
        request.end()
    })
}


// Goltocraft 1.0.147: téléchargement via Chromium DownloadItem.
// Cette voie utilise exactement le gestionnaire de téléchargement de la session Electron
// et évite le flux net.request qui pouvait rester à 0 octet sur les assets GitHub.
function goltoDownloadWithSession(event, url, destination, onProgress, expectedTotal = 0) {
    return new Promise((resolve, reject) => {
        const ses = event && event.sender && event.sender.session
        if(!ses) return reject(new Error('Session Electron indisponible'))
        let itemRef = null
        let finished = false
        let watchdog = null

        const cleanup = () => {
            if(watchdog) clearTimeout(watchdog)
            try { ses.removeListener('will-download', onWillDownload) } catch(e) {}
        }
        const fail = err => {
            if(finished) return
            finished = true
            cleanup()
            try { if(itemRef && !itemRef.isDestroyed()) itemRef.cancel() } catch(e) {}
            try { if(fs.existsSync(destination)) fs.unlinkSync(destination) } catch(e) {}
            reject(err instanceof Error ? err : new Error(String(err)))
        }
        const arm = () => {
            if(watchdog) clearTimeout(watchdog)
            watchdog = setTimeout(() => fail(new Error('Téléchargement GitHub bloqué: aucune progression pendant 60 secondes')), 60000)
        }
        const onWillDownload = (downloadEvent, item) => {
            if(finished || itemRef) return
            itemRef = item
            try { item.setSavePath(destination) } catch(err) { return fail(err) }
            const report = () => {
                arm()
                const transferred = Number(item.getReceivedBytes() || 0)
                const reportedTotal = Number(item.getTotalBytes() || 0)
                const total = reportedTotal > 0 ? reportedTotal : Number(expectedTotal || 0)
                const percent = total > 0 ? Math.min(100, transferred / total * 100) : 0
                onProgress({ percent, transferred, total })
            }
            onProgress({ percent:0, transferred:0, total:Number(item.getTotalBytes() || expectedTotal || 0) })
            arm()
            item.on('updated', report)
            item.once('done', (e, state) => {
                if(finished) return
                if(state !== 'completed') return fail(new Error(`Téléchargement interrompu (${state})`))
                finished = true
                cleanup()
                const transferred = Number(item.getReceivedBytes() || 0)
                const total = Number(item.getTotalBytes() || expectedTotal || transferred || 0)
                onProgress({ percent:100, transferred, total })
                resolve(destination)
            })
        }
        ses.on('will-download', onWillDownload)
        arm()
        try { ses.downloadURL(url) } catch(err) { fail(err) }
    })
}

// Goltocraft 1.0.113: URL de téléchargement dédiée à chaque version.
// Le fichier launcher-update-urls.json peut contenir une URL directe par version.
// Si l'URL est vide, on utilise l'URL exacte de l'asset .exe de la release GitHub de CETTE version.
function goltoGetConfiguredUpdateUrl(version) {
    try {
        const cfgPath = path.join(__dirname, 'launcher-update-urls.json')
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
        const entry = cfg && cfg.versions ? cfg.versions[String(version)] : null
        if(entry && typeof entry.url === 'string' && /^https:\/\//i.test(entry.url.trim())) return entry.url.trim()
    } catch(err) {
        console.warn('[Goltocraft Updater] Configuration URL non lisible:', err.message)
    }
    return null
}

function goltoFindInstallerAsset(release, version) {
    const assets = Array.isArray(release && release.assets) ? release.assets : []
    const versionText = String(version || '')
    return assets.find(a => versionText && new RegExp(versionText.replace(/\./g, '\\.'), 'i').test(a.name || '') && /setup.*\.exe$/i.test(a.name || ''))
        || assets.find(a => /setup.*\.exe$/i.test(a.name || ''))
        || assets.find(a => /\.exe$/i.test(a.name || ''))
}

async function goltoRedownloadLatestPublic(event) {
    goltoUpdateSender = event.sender
    if(goltoReinstallDownloading) return
    goltoReinstallDownloading = true
    // 1.0.109: notifier immédiatement l’interface, sans attendre la réponse GitHub.
    goltoSendUpdateStatus('reinstall-started', { version: app.getVersion() })
    try {
        const latest = await goltoGetLatestGitHubRelease()
        const asset = goltoFindInstallerAsset(latest.release, latest.version)
        const configuredUrl = goltoGetConfiguredUpdateUrl(latest.version)
        // Le build Windows utilise toujours artifactName: Goltocraft-Launcher-Setup.exe.
        // On essaie d'abord l'URL explicite de la version, puis l'asset renvoyé par l'API,
        // puis l'URL GitHub stable de la dernière release.
        const stableLatestUrl = 'https://github.com/NWFORFALTAXDFRS/Goltocraft-Launcher/releases/latest/download/Goltocraft-Launcher-Setup.exe'
        const downloadUrl = configuredUrl || (asset && asset.browser_download_url) || stableLatestUrl
        const destination = path.join(os.tmpdir(), `Goltocraft-Launcher-${latest.version}-Setup.exe`)
        try { if(fs.existsSync(destination)) fs.unlinkSync(destination) } catch(e) {}
        goltoSendUpdateStatus('reinstall-url-resolved', { version: latest.version, url: downloadUrl })
        const expectedTotal = Number(asset && asset.size || 0)
        goltoSendUpdateStatus('reinstall-progress', { percent: 0, transferred: 0, total: expectedTotal })
        await goltoDownloadWithSession(event, downloadUrl, destination, p => goltoSendUpdateStatus('reinstall-progress', p), expectedTotal)
        goltoReinstallInstallerPath = destination
        goltoSendUpdateStatus('reinstall-downloaded', { version: latest.version, installerPath: destination })
    } catch(err) {
        console.error('[Goltocraft Updater] re-download failed:', err)
        goltoSendUpdateStatus('realerror', err)
    } finally {
        goltoReinstallDownloading = false
    }
}


async function goltoDownloadLatestPublicUpdate(event) {
    goltoUpdateSender = event.sender
    if(goltoUpdateDownloading) return
    goltoUpdateDownloading = true
    goltoElectronUpdateReady = false
    try {
        const latest = await goltoGetLatestGitHubRelease()
        const current = app.getVersion()
        if(!semver.valid(latest.version) || !semver.valid(current) || !semver.gt(latest.version, current)) {
            throw new Error(`Aucune mise à jour plus récente (${current} / ${latest.version})`)
        }

        // 1.0.159 : on reprend le téléchargement direct Chromium qui fonctionnait
        // dans la 1.0.149/1.0.156. La détection jaune/rouge reste indépendante.
        // Une fois rouge, on télécharge réellement l'asset Setup.exe de cette release.
        if(goltoUpdateDownloaded && goltoUpdateDownloadedVersion === latest.version &&
           goltoReinstallInstallerPath && fs.existsSync(goltoReinstallInstallerPath)) {
            goltoSendUpdateStatus('update-downloaded', {
                version: latest.version,
                installerPath: goltoReinstallInstallerPath
            })
            return
        }

        if(goltoUpdateDownloadedVersion !== latest.version) {
            goltoUpdateDownloaded = false
            goltoUpdateDownloadedVersion = null
            if(goltoReinstallInstallerPath) {
                try { if(fs.existsSync(goltoReinstallInstallerPath)) fs.unlinkSync(goltoReinstallInstallerPath) } catch(e) {}
                goltoReinstallInstallerPath = null
            }
        }

        const assets = Array.isArray(latest.release && latest.release.assets) ? latest.release.assets : []
        const asset = goltoFindInstallerAsset(latest.release, latest.version)
        const metadata = assets.find(a => /^latest\.yml$/i.test(String(a && a.name || '')))
        if(!asset || !asset.browser_download_url || !metadata) {
            goltoSendUpdateStatus('update-assets-preparing', { version: latest.version })
            throw new Error(`La version ${latest.version} est encore en préparation.`)
        }

        const destination = path.join(os.tmpdir(), `Goltocraft-Launcher-${latest.version}-Setup.exe`)
        try { if(fs.existsSync(destination)) fs.unlinkSync(destination) } catch(e) {}

        const expectedTotal = Number(asset.size || 0)
        goltoSendUpdateStatus('download-progress', { percent: 0, transferred: 0, total: expectedTotal })
        await goltoDownloadWithSession(
            event,
            asset.browser_download_url,
            destination,
            progress => goltoSendUpdateStatus('download-progress', progress),
            expectedTotal
        )

        if(!fs.existsSync(destination) || fs.statSync(destination).size <= 0) {
            throw new Error('Le fichier de mise à jour téléchargé est vide ou introuvable.')
        }

        goltoReinstallInstallerPath = destination
        goltoUpdateDownloaded = true
        goltoUpdateDownloadedVersion = latest.version
        goltoSendUpdateStatus('update-downloaded', {
            version: latest.version,
            installerPath: destination,
            total: fs.statSync(destination).size
        })
    } catch(err) {
        console.error('[Goltocraft Updater] direct public update failed:', err)
        goltoSendUpdateStatus('realerror', err)
    } finally {
        goltoUpdateDownloading = false
    }
}

// Goltocraft 1.0.150: installe réellement la mise à jour puis relance
// l'exécutable installé. Le petit script externe attend la fermeture du
// launcher afin que NSIS puisse remplacer les fichiers actuellement utilisés.
function goltoInstallDownloadedAndRestart() {
    // 1.0.151: quand le téléchargement vient d'electron-updater, laisser
    // electron-updater appliquer le paquet NSIS qu'il a lui-même préparé.
    if(goltoElectronUpdateReady) {
        goltoSendUpdateStatus('install-started', { version: goltoUpdateDownloadedVersion })
        setTimeout(() => autoUpdater.quitAndInstall(false, true), 250)
        return
    }
    if(!goltoReinstallInstallerPath || !fs.existsSync(goltoReinstallInstallerPath)) {
        goltoSendUpdateStatus('realerror', new Error('Installateur téléchargé introuvable.'))
        return
    }

    const installer = goltoReinstallInstallerPath
    const launcherExe = app.getPath('exe')
    const scriptPath = path.join(os.tmpdir(), `goltocraft-update-${Date.now()}.cmd`)
    const q = value => `"${String(value).replace(/"/g, '""')}"`
    const script = [
        '@echo off',
        'timeout /t 2 /nobreak >nul',
        `start /wait "" ${q(installer)} /S`,
        'timeout /t 1 /nobreak >nul',
        `start "" ${q(launcherExe)}`,
        `del /q ${q(scriptPath)} >nul 2>&1`
    ].join('\r\n')

    fs.writeFileSync(scriptPath, script, 'utf8')
    goltoSendUpdateStatus('install-started', { version: goltoUpdateDownloadedVersion })
    const child = spawn('cmd.exe', ['/d', '/s', '/c', scriptPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
    })
    child.unref()
    setTimeout(() => app.quit(), 300)
}

ipcMain.on('autoUpdateAction', (event, arg, data) => {
    switch(arg) {
        case 'initAutoUpdater':
            console.log('Initializing Goltocraft auto updater.')
            initAutoUpdater(event, data)
            event.sender.send('autoUpdateNotification', 'ready')
            break
        case 'checkForUpdate':
            goltoCheckForUpdates(event)
            break
        case 'allowPrereleaseChange':
            if(!data) {
                const preRelComp = semver.prerelease(app.getVersion())
                autoUpdater.allowPrerelease = preRelComp != null && preRelComp.length > 0
            } else {
                autoUpdater.allowPrerelease = data
            }
            break
        case 'redownloadLatest':
            goltoRedownloadLatestPublic(event)
            break
        case 'installDownloadedInstaller':
            goltoInstallDownloadedAndRestart()
            break
        case 'openUpdateOnGitHub': {
            // Téléchargement direct du SEUL fichier destiné aux joueurs.
            // Aucune page Releases ni liste d'anciennes versions n'est ouverte.
            // /latest/ redirige toujours vers le Setup de la dernière release publique.
            const version = data ? String(data).trim().replace(/^v/i, '') : ''
            const downloadUrl = 'https://github.com/NWFORFALTAXDFRS/Goltocraft-Launcher/releases/latest/download/Goltocraft-Launcher-Setup.exe'
            shell.openExternal(downloadUrl).then(() => {
                goltoSendUpdateStatus('github-page-opened', { version: version || null, url: downloadUrl, directDownload: true })
            }).catch(err => {
                console.error('[Goltocraft Updater] Impossible d’ouvrir le téléchargement direct:', err)
                goltoSendUpdateStatus('github-open-error', { version: version || null, message: String(err && err.message || err) })
            })
            break
        }
        case 'downloadUpdate':
            goltoDownloadLatestPublicUpdate(event)
            break
        case 'installUpdateNow':
            if(goltoUpdateDownloaded) goltoInstallDownloadedAndRestart()
            break
        default:
            console.log('Unknown argument', arg)
            break
    }
})

// Redirect distribution index event from preloader to renderer.
ipcMain.on('distributionIndexDone', (event, res) => {
    event.sender.send('distributionIndexDone', res)
})

// Handle trash item.
ipcMain.handle(SHELL_OPCODE.TRASH_ITEM, async (event, ...args) => {
    try {
        await shell.trashItem(args[0])
        return {
            result: true
        }
    } catch(error) {
        return {
            result: false,
            error: error
        }
    }
})

// Disable hardware acceleration.
// https://electronjs.org/docs/tutorial/offscreen-rendering
app.disableHardwareAcceleration()

// Goltocraft v28: force the Windows taskbar identity/icon to Goltocraft.
if (process.platform === 'win32') {
    app.setAppUserModelId('fr.goltocraft.launcher')
}


const REDIRECT_URI_PREFIX = 'https://login.microsoftonline.com/common/oauth2/nativeclient?'

// Microsoft Auth Login
let msftAuthWindow
let msftAuthSuccess
let msftAuthViewSuccess
let msftAuthViewOnClose
ipcMain.on(MSFT_OPCODE.OPEN_LOGIN, (ipcEvent, ...arguments_) => {
    if (msftAuthWindow) {
        ipcEvent.reply(MSFT_OPCODE.REPLY_LOGIN, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.ALREADY_OPEN, msftAuthViewOnClose)
        return
    }
    msftAuthSuccess = false
    msftAuthViewSuccess = arguments_[0]
    msftAuthViewOnClose = arguments_[1]
    msftAuthWindow = new BrowserWindow({
        title: LangLoader.queryJS('index.microsoftLoginTitle'),
        backgroundColor: '#222222',
        width: 520,
        height: 600,
        frame: true,
        icon: getPlatformIcon('SealCircle')
    })

    msftAuthWindow.on('closed', () => {
        msftAuthWindow = undefined
    })

    msftAuthWindow.on('close', () => {
        if(!msftAuthSuccess) {
            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGIN, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.NOT_FINISHED, msftAuthViewOnClose)
        }
    })

    msftAuthWindow.webContents.on('did-navigate', (_, uri) => {
        if (uri.startsWith(REDIRECT_URI_PREFIX)) {
            let queryMap = {}
            
            new URL(uri).searchParams.forEach((v, k) => {
                queryMap[k] = v;
            });

            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGIN, MSFT_REPLY_TYPE.SUCCESS, queryMap, msftAuthViewSuccess)

            msftAuthSuccess = true
            msftAuthWindow.close()
            msftAuthWindow = null
        }
    })

    msftAuthWindow.removeMenu()
    msftAuthWindow.loadURL(`https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?prompt=select_account&client_id=${AZURE_CLIENT_ID}&response_type=code&scope=XboxLive.signin%20offline_access&redirect_uri=https://login.microsoftonline.com/common/oauth2/nativeclient`)
})

// Microsoft Auth Logout
let msftLogoutWindow
let msftLogoutSuccess
let msftLogoutSuccessSent
ipcMain.on(MSFT_OPCODE.OPEN_LOGOUT, (ipcEvent, uuid, isLastAccount) => {
    if (msftLogoutWindow) {
        ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.ALREADY_OPEN)
        return
    }

    msftLogoutSuccess = false
    msftLogoutSuccessSent = false
    msftLogoutWindow = new BrowserWindow({
        title: LangLoader.queryJS('index.microsoftLogoutTitle'),
        backgroundColor: '#222222',
        width: 520,
        height: 600,
        frame: true,
        icon: getPlatformIcon('SealCircle')
    })

    msftLogoutWindow.on('closed', () => {
        msftLogoutWindow = undefined
    })

    msftLogoutWindow.on('close', () => {
        if(!msftLogoutSuccess) {
            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.NOT_FINISHED)
        } else if(!msftLogoutSuccessSent) {
            msftLogoutSuccessSent = true
            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.SUCCESS, uuid, isLastAccount)
        }
    })
    
    msftLogoutWindow.webContents.on('did-navigate', (_, uri) => {
        if(uri.startsWith('https://login.microsoftonline.com/common/oauth2/v2.0/logoutsession')) {
            msftLogoutSuccess = true
            setTimeout(() => {
                if(!msftLogoutSuccessSent) {
                    msftLogoutSuccessSent = true
                    ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.SUCCESS, uuid, isLastAccount)
                }

                if(msftLogoutWindow) {
                    msftLogoutWindow.close()
                    msftLogoutWindow = null
                }
            }, 5000)
        }
    })
    
    msftLogoutWindow.removeMenu()
    msftLogoutWindow.loadURL('https://login.microsoftonline.com/common/oauth2/v2.0/logout')
})

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let win

function createWindow() {

    win = new BrowserWindow({
        width: 980,
        height: 552,
        minWidth: 980,
        minHeight: 552,
        icon: getPlatformIcon('SealCircle'),
        frame: false,
        webPreferences: {
            preload: path.join(__dirname, 'app', 'assets', 'js', 'preloader.js'),
            nodeIntegration: true,
            contextIsolation: false
        },
        backgroundColor: '#171614'
    })
    remoteMain.enable(win.webContents)

    const data = {
        bkid: Math.floor((Math.random() * fs.readdirSync(path.join(__dirname, 'app', 'assets', 'images', 'backgrounds')).length)),
        lang: (str, placeHolders) => LangLoader.queryEJS(str, placeHolders)
    }
    Object.entries(data).forEach(([key, val]) => ejse.data(key, val))

    win.loadURL(pathToFileURL(path.join(__dirname, 'app', 'app.ejs')).toString())

    /*win.once('ready-to-show', () => {
        win.show()
    })*/

    win.removeMenu()

    win.resizable = true

    win.on('closed', () => {
        win = null
    })
}

function createMenu() {
    
    if(process.platform === 'darwin') {

        // Extend default included application menu to continue support for quit keyboard shortcut
        let applicationSubMenu = {
            label: 'Application',
            submenu: [{
                label: 'About Application',
                selector: 'orderFrontStandardAboutPanel:'
            }, {
                type: 'separator'
            }, {
                label: 'Quit',
                accelerator: 'Command+Q',
                click: () => {
                    app.quit()
                }
            }]
        }

        // New edit menu adds support for text-editing keyboard shortcuts
        let editSubMenu = {
            label: 'Edit',
            submenu: [{
                label: 'Undo',
                accelerator: 'CmdOrCtrl+Z',
                selector: 'undo:'
            }, {
                label: 'Redo',
                accelerator: 'Shift+CmdOrCtrl+Z',
                selector: 'redo:'
            }, {
                type: 'separator'
            }, {
                label: 'Cut',
                accelerator: 'CmdOrCtrl+X',
                selector: 'cut:'
            }, {
                label: 'Copy',
                accelerator: 'CmdOrCtrl+C',
                selector: 'copy:'
            }, {
                label: 'Paste',
                accelerator: 'CmdOrCtrl+V',
                selector: 'paste:'
            }, {
                label: 'Select All',
                accelerator: 'CmdOrCtrl+A',
                selector: 'selectAll:'
            }]
        }

        // Bundle submenus into a single template and build a menu object with it
        let menuTemplate = [applicationSubMenu, editSubMenu]
        let menuObject = Menu.buildFromTemplate(menuTemplate)

        // Assign it to the application
        Menu.setApplicationMenu(menuObject)

    }

}

function getPlatformIcon(filename){
    let ext
    switch(process.platform) {
        case 'win32':
            ext = 'ico'
            break
        case 'darwin':
        case 'linux':
        default:
            ext = 'png'
            break
    }

    return path.join(__dirname, 'app', 'assets', 'images', `${filename}.${ext}`)
}

app.on('ready', createWindow)
app.on('ready', createMenu)

app.on('window-all-closed', () => {
    // On macOS it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    if (process.platform !== 'darwin') {
        app.quit()
    }
})

app.on('activate', () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (win === null) {
        createWindow()
    }
})
