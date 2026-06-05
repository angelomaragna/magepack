/* eslint-env browser */

const staticExcludedModules = require('./excludedModules');
const logger = require('../utils/logger');

/**
 * Collects all defined RequireJS modules on a given page.
 */
module.exports = async (page, excModules) => {
    var excludedModules = staticExcludedModules;

    if (excModules) {
        excModules = excModules.split(',');
        excludedModules = staticExcludedModules.concat(excModules);
    }

    /**
     * Log console messages with proper real-time streaming
     */
    page.on('console', (message) => {
        const text = message.text();
        const type = message.type().toUpperCase();

        // Use logger instead of console.log for proper streaming
        logger.info(`${type} ${text}`);

        // Force flush for real-time output
        if (process.stdout.isTTY) {
            process.stdout.write('');
        }
    })
        .on('pageerror', ({ message }) => {
            logger.error(`PAGE ERROR: ${message}`);

            // Force flush for real-time output
            if (process.stderr.isTTY) {
                process.stderr.write('');
            }
        })
        .on('requestfailed', (request) => {
            logger.warn(
                `REQUEST FAILED: ${
                    request.failure().errorText
                } ${request.url()}`
            );

            // Force flush for real-time output
            if (process.stderr.isTTY) {
                process.stderr.write('');
            }
        });

    /**
     * Wait to make sure RequireJS is loaded.
     */
    await page.waitForFunction(
        () => {
            return window.require;
        },
        { timeout: 30000 }
    );

    /**
     * Fix orphaned module ids that headless Chromium gets permanently stuck on.
     *
     * Two root causes:
     * 1. jquery-ui-modules/widget (dash) vs jquery/ui-modules/widget (slash):
     *    widget.js uses an anonymous define() which RequireJS binds to the slash id
     *    (loaded via map config). The dash id ends up in the registry with no factory
     *    and depCount=0, permanently orphaned. All modal/collapsible/minicart/sidebar
     *    deps cascade behind it (27 modules total).
     *
     * 2. Circular self-dependencies (e.g. ajaxinfinitescroll requiring its own alias):
     *    RequireJS cannot break these on its own without a factory already having run.
     *
     * Fix: directly mark the stuck module as defined in the RequireJS context and fire
     * its stored 'defined' event callbacks so dependents cascade normally.
     * define() alone does not work here — it pushes to globalDefQueue which is only
     * drained on script-tag load events, never from page.evaluate().
     */
    await page.evaluate(() => {
        function fireModuleDefined(mod, val, defined, registry) {
            defined[mod.map.id] = val;
            delete registry[mod.map.id];
            const cbs = mod.events && mod.events.defined;
            (cbs || []).forEach(function (cb) {
                try { cb(val); } catch (e) {}
            });
        }

        const ctx = require.s.contexts._;
        const defined = ctx.defined;
        const registry = ctx.registry;

        // Fix 1: dash/slash widget alias split
        const slashVal = defined['jquery/ui-modules/widget'];
        const dashMod = registry['jquery-ui-modules/widget'];
        if (dashMod && defined['jquery-ui-modules/widget'] === undefined && slashVal !== undefined) {
            fireModuleDefined(dashMod, slashVal, defined, registry);
        }

        // Fix 2: modules stuck waiting only for themselves (circular self-dep via alias)
        var progress = true;
        var rounds = 0;
        while (progress && rounds < 10) {
            progress = false;
            rounds++;
            Object.keys(registry).forEach(function (name) {
                const mod = registry[name];
                if (!mod || !mod.inited) return;
                const unmatched = (mod.depMaps || []).filter(function (dm, i) {
                    return !(mod.depMatched && mod.depMatched[i]) && defined[dm.id] === undefined;
                });
                const selfOnly = unmatched.length > 0 && unmatched.every(function (dm) {
                    return dm.id === name;
                });
                if (selfOnly) {
                    fireModuleDefined(mod, mod.exports || {}, defined, registry);
                    progress = true;
                }
            });
        }
    });

    /**
     * Use Magento's rjsResolver to wait for all modules to load.
     */
    await page.evaluate(() => {
        return new Promise((resolve, reject) => {
            let diagnosticInterval;

            const timeout = setTimeout(() => {
                clearInterval(diagnosticInterval);
                reject(new Error('rjsResolver timeout'));
            }, 1800000); // 30 min

            diagnosticInterval = setInterval(() => {
                const registry = require.s.contexts._.registry;
                const defined = require.s.contexts._.defined;
                const pendingNames = Object.keys(registry);

                if (pendingNames.length === 0) {
                    console.log('[DIAG] 0 pending — rjsResolver should fire soon');
                    return;
                }

                // Find root blockers: stuck modules whose own deps are all defined (not pending)
                const rootBlockers = pendingNames.filter(name => {
                    const mod = registry[name];
                    const deps = (mod.depMaps || []).map(d => d.name).filter(d => d !== 'require' && d !== 'exports' && d !== 'module');
                    return deps.every(d => !!defined[d]);
                });

                console.log('[DIAG] ' + pendingNames.length + ' pending. ROOT BLOCKERS (deps all resolved): ' + (rootBlockers.join(', ') || 'none found'));
            }, 5000);

            require(['rjsResolver'], function (resolver) {
                resolver(() => {
                    clearTimeout(timeout);
                    clearInterval(diagnosticInterval);
                    resolve();
                });
            });
        });
    });

    /**
     * Wait for browser to be idle for a good measure.
     */
    await page.evaluate(() => {
        return new Promise((resolve) => {
            const timeout = setTimeout(resolve, 10000); // 10s fallback
            if (typeof requestIdleCallback !== 'undefined') {
                requestIdleCallback(() => {
                    clearTimeout(timeout);
                    resolve();
                });
            } else {
                // Fallback if requestIdleCallback is not available
                setTimeout(resolve, 2000);
            }
        });
    });

    /**
     * Wait another 5s for a good measure.
     */
    await page.waitFor(5000);

    const modules = await page.evaluate((excludedModules) => {
        function extractBaseUrl(require) {
            const baseUrl = require.toUrl('');
            return baseUrl.replace(/\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/$/, '/');
        }

        function stripBaseUrl(baseUrl, moduleUrl) {
            if (!moduleUrl.startsWith(baseUrl)) {
                return moduleUrl;
            }

            return moduleUrl
                .substring(baseUrl.length)
                .replace(/^[^/]+\/[^/]+\/[^/]+\/[^/]+\//, '');
        }

        const stripPlugin = (moduleName) => moduleName.replace(/^[^!].+!/, '');

        const baseUrl = extractBaseUrl(require);

        const contexts = require.s.contexts;
        const defContext = contexts._;
        const defaultContextConfig = defContext.config;
        const unbundledContextConfig = {
            baseUrl: defaultContextConfig.baseUrl,
            paths: defaultContextConfig.paths,
            shim: defaultContextConfig.shim,
            config: defaultContextConfig.config,
            map: defaultContextConfig.map,
        };
        const unbundledContext = require.s.newContext('magepack');

        /**
         * Prepare a separate context where modules are not assigned to bundles.
         * This make it possible to fetch real module paths even with bundling enabled.
         */
        unbundledContext.configure(unbundledContextConfig);

        const modules = {};
        Object.keys(window.require.s.contexts._.defined).forEach(
            (moduleName) => {
                /**
                 * Ignore all modules that are loaded with plugins other than text.
                 */
                if (
                    (moduleName.includes('!') &&
                        !moduleName.startsWith('text!')) ||
                    moduleName.match(/^(https?:)?\/\//)
                ) {
                    return;
                }

                /**
                 * Ignore excluded modules.
                 */
                if (excludedModules.includes(moduleName)) {
                    return;
                }

                /**
                 * Get module path from resolved url
                 */
                modules[moduleName] = stripBaseUrl(
                    baseUrl,
                    unbundledContext.require.toUrl(stripPlugin(moduleName))
                );

                if (
                    Object.prototype.hasOwnProperty.call(
                        window.require.s.contexts._.config.config.mixins,
                        moduleName
                    )
                ) {
                    for (const [mixinModuleName, enabled] of Object.entries(
                        window.require.s.contexts._.config.config.mixins[
                            moduleName
                        ]
                    )) {
                        if (enabled) {
                            modules[mixinModuleName] = stripBaseUrl(
                                baseUrl,
                                unbundledContext.require.toUrl(
                                    stripPlugin(mixinModuleName)
                                )
                            );
                        }
                    }
                }
            }
        );

        return modules;
    }, excludedModules);

    return modules;
};
