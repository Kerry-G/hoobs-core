/**************************************************************************************************
 * hoobs-core                                                                                     *
 * Copyright (C) 2020 HOOBS                                                                       *
 *                                                                                                *
 * This program is free software: you can redistribute it and/or modify                           *
 * it under the terms of the GNU General Public License as published by                           *
 * the Free Software Foundation, either version 3 of the License, or                              *
 * (at your option) any later version.                                                            *
 *                                                                                                *
 * This program is distributed in the hope that it will be useful,                                *
 * but WITHOUT ANY WARRANTY; without even the implied warranty of                                 *
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the                                  *
 * GNU General Public License for more details.                                                   *
 *                                                                                                *
 * You should have received a copy of the GNU General Public License                              *
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.                          *
 **************************************************************************************************/

const _ = require("lodash");

const OS = require("os");
const File = require("fs-extra");

const { dirname, join } = require("path");
const { spawn, execSync } = require("child_process");

module.exports = (password, reload) => {
    const home = OS.userInfo().homedir;
    const root = join(home, ".hoobs");
    const applicaiton = join(dirname(File.realpathSync(__filename)), "../");
    const installed = tryParseFile(join(applicaiton, "package.json"));

    if (!installed) {
        throw new Error("HOOBS Installation is Corrupt. Please Re-Install HOOBS.");
    }

    if (!File.existsSync(root)) {
        File.mkdirSync(root);
    }

    const executing = tryParseFile(join(root, "package.json"), {});

    checkEnviornment(home, password).then(() => {
        if (!executing || installed.version !== executing.version || !(checksum(root, executing, installed))) {
            let success = true;

            if (File.existsSync("/var/hoobs/.migration")) {
                migrate(root);

                if (preparePackage(root, executing, installed)) {
                    setupUserMode(root, applicaiton);

                    execSudo(password, [
                        "rm",
                        "-fR",
                        "/var/hoobs/.migration"
                    ]);
                }
            } else {
                if (preparePackage(root, executing, installed)) {
                    setupUserMode(root, applicaiton);
                } else {
                    success = false;

                    console.log("---------------------------------------------------------");
                    console.log("There are configured plugins that are not installed.");
                    console.log("Please edit your config.json file and remove the missing");
                    console.log("plugin configurations, and remove the plugin from the");
                    console.log("plugins array.");
                    console.log("---------------------------------------------------------");
                    console.log("Loading previous version");
                    console.log("---------------------------------------------------------");
                }
            }

            if (success) {
                if (File.existsSync("/etc/systemd/system/multi-user.target.wants/nginx.service")) {
                    console.log("Restarting NGINX");

                    execSudo(password, [
                        "systemctl",
                        "restart",
                        "nginx.service"
                    ]);
                }

                if (!reload) {
                    require(join(applicaiton, "lib", "cli"))();
                }
            }
        } else if (!reload) {
            require(join(applicaiton, "lib", "cli"))();
        }
    });
};

const tryParseFile = function(filename, replacement) {
    replacement = replacement || null;

    try {
        return JSON.parse(File.readFileSync(filename));
    } catch {
        return replacement;
    }
};

const preparePackage = function (root, executing, installed) {
    let plugins = [];
    let success = true;
    let fix = false;

    if (File.existsSync(join(root, "node_modules", "@hoobs", "hoobs"))) {
        fix = true;
    }

    if (File.existsSync(join(root, "dist"))) {
        File.removeSync(join(root, "dist"));
    }

    if (File.existsSync(join(root, "node_modules", "homebridge"))) {
        try {
            File.unlinkSync(join(root, "node_modules", "homebridge"));
        } catch (_error) {
            File.removeSync(join(root, "node_modules", "homebridge"));
        }
    }

    if (File.existsSync(join(root, "node_modules", "hap-nodejs"))) {
        try {
            File.unlinkSync(join(root, "node_modules", "hap-nodejs"));
        } catch (_error) {
            File.removeSync(join(root, "node_modules", "hap-nodejs"));
        }
    }

    if (File.existsSync("/var/hoobs/.migration/plugins.json")) {
        plugins = tryParseFile("/var/hoobs/.migration/plugins.json", []);
    }

    if (installed.dependencies) {
        installed.dependencies = {};
    }

    if (File.existsSync("/var/hoobs/.migration/dependencies.json")) {
        installed.dependencies = tryParseFile("/var/hoobs/.migration/dependencies.json", installed.dependencies);
    } else if (executing && executing.dependencies) {
        const current = tryParseFile(join(root, "etc", "config.json"), null);

        const deps = (current || {}).plugins || [];
        const keys = Object.keys(executing.dependencies);
        const orphaned = [];

        for (let i = 0; i < deps.length; i++) {
            let dep = null;
            let name = deps[i];

            if (executing.dependencies[name]) {
                dep = name;
            } else {
                dep = (keys.filter(d => d.startsWith("@") && d.endsWith(`/${name}`)) || [null])[0];
            }

            if (dep && executing.dependencies[dep]) {
                installed.dependencies[dep] = executing.dependencies[dep];
            } else if (current && (current.accessories || []).findIndex(a => (a.plugin_map || {}).plugin_name === name) === -1 && (current.platforms || []).findIndex(p => (p.plugin_map || {}).plugin_name === name) === -1) {
                orphaned.push(name);
            } else {
                console.log(`Plugin "${name}" is missing`);

                success = false;
            }

            if (dep && !File.existsSync(join(root, "node_modules", dep))) {
                fix = true;
            }
        }

        if (success && orphaned.length > 0) {
            for (let i = 0; i < orphaned.length; i++) {
                const index = (current.plugins || []).indexOf(orphaned[i]);

                if (index > -1) {
                    current.plugins.splice(index, 1);
                }
            }

            File.unlinkSync(join(root, "etc", "config.json"));
            File.appendFileSync(join(root, "etc", "config.json"), JSON.stringify(current, null, 4));
        }
    }

    if (success) {
        if (installed.devDependencies) {
            delete installed.devDependencies;
        }

        if (installed.scripts) {
            delete installed.scripts;
        }

        if (installed.bin) {
            delete installed.bin;
        }

        console.log("Writing package file");

        if (File.existsSync(join(root, "package.json"))) {
            File.unlinkSync(join(root, "package.json"));
        }

        File.appendFileSync(join(root, "package.json"), JSON.stringify(installed, null, 4));

        for (let i = 0; i < plugins.length; i++) {   
            execSync(`npm install --prefer-offline --no-audit --progress=true --unsafe-perm ${plugins[i].name}${plugins[i].version && plugins[i].version !== "" ? `@${plugins[i].version}` : ""}`, {
                cwd: root,
                stdio: ["inherit", "inherit", "inherit"]
            });
        }

        if (fix) {
            execSync("npm install --unsafe-perm --prefer-offline --no-audit --progress=true", {
                cwd: root,
                stdio: ["inherit", "inherit", "inherit"]
            });
        }
    }

    return success;
};

const setupUserMode = function (root, applicaiton) {
    return new Promise((resolve) => {
        if (File.existsSync("/var/hoobs/.migration/config.json")) {
            let current = {
                bridge: {
                    name: "HOOBS",
                    port: 51826,
                    pin: "031-45-154"
                },
                description: "",
                ports: {},
                plugins: [],
                interfaces: [],
                accessories: [],
                platforms: []
            };

            console.log("Migrating existing configuration");

            current = _.extend(current, tryParseFile(join(applicaiton, "default.json"), current));
            current = _.extend(current, tryParseFile("/var/hoobs/.migration/config.json", current));

            if (current.plugins.length === 0 && File.existsSync("/var/hoobs/.migration/plugins.json")) {
                console.log("Creating plugin white list");

                const plugins = tryParseFile("/var/hoobs/.migration/plugins.json", []);

                for (let i = 0; i < plugins.length; i++) {
                    if (current.plugins.indexOf(plugins[i].name) === -1) {
                        current.plugins.push(plugins[i].name);
                    }
                }

                console.log("Mapping plugins");

                const platforms = {};
                const accessories = {};

                for (let i = 0; i < (current.platforms || []).length; i++) {
                    if (!platforms[current.platforms[i].platform]) {
                        platforms[current.platforms[i].platform] = [];
                    }

                    platforms[current.platforms[i].platform].push(i);
                }

                for (let i = 0; i < (current.accessories || []).length; i++) {
                    if (!accessories[current.accessories[i].accessory]) {
                        accessories[current.accessories[i].accessory] = [];
                    }

                    accessories[current.accessories[i].accessory].push(i);
                }

                for (let i = 0; i < plugins.length; i++) {
                    for (let j = 0; j < (plugins[i].details || []).length; j++) {
                        switch (plugins[i].details[j].type) {
                            case "platform":
                                for (let k = 0; k < (platforms[plugins[i].details[j].alias] || []).length; k++) {
                                    current.platforms[platforms[plugins[i].details[j].alias][k]].plugin_map = {
                                        plugin_name: plugins[i].name
                                    }
                                }

                                break;

                            case "accessory":
                                for (let k = 0; k < (accessories[plugins[i].details[j].alias] || []).length; k++) {
                                    current.accessories[accessories[plugins[i].details[j].alias][k]].plugin_map = {
                                        plugin_name: plugins[i].name,
                                        index: 0
                                    }
                                }

                                break;
                        }
                    }
                }
            }

            if (File.existsSync(join(root, "etc", "config.json"))) {
                File.unlinkSync(join(root, "etc", "config.json"));
            }

            File.appendFileSync(join(root, "etc", "config.json"), JSON.stringify(current, null, 4));
        }

        resolve();
    });
};

const checkEnviornment = function (home, password) {
    return new Promise((resolve) => {
        const queue = [];

        if (File.existsSync(join(home, ".npm"))) {
            try {
                File.accessSync(join(home, ".npm"), File.constants.W_OK);
            } catch (err) {
                console.log(`NPM Cache is Root Locked`);

                execSudo(password, [
                    "rm",
                    "-fR",
                    join(home, ".npm")
                ]);
            }
        }

        if (File.existsSync(join(home, ".config"))) {
            try {
                File.accessSync(join(home, ".config"), File.constants.W_OK);
            } catch (err) {
                console.log(`NPM Configuration is Root Locked`);

                execSudo(password, [
                    "rm",
                    "-fR",
                    join(home, ".config")
                ]);
            }
        }

        if (File.existsSync(join(home, ".node-gyp"))) {
            try {
                File.accessSync(join(home, ".node-gyp"), File.constants.W_OK);
            } catch (err) {
                console.log(`GYP Build Cache is Root Locked`);

                execSudo(password, [
                    "rm",
                    "-fR",
                    join(home, ".node-gyp")
                ]);
            }
        }

        if (queue.length === 0) {
            resolve();
        }
    });
};

const migrate = function (root) {
    if (File.existsSync("/var/hoobs/.migration/access.json")) {
        console.log("Migrating access.json");

        if (File.existsSync(join(root, "etc", "access.json"))) {
            File.unlinkSync(join(root, "etc", "access.json"));
        }

        File.copySync("/var/hoobs/.migration/access.json", join(root, "etc", "access.json"));
    }

    if (File.existsSync("/var/hoobs/.migration/layout.json")) {
        console.log("Migrating layout.json");

        if (File.existsSync(join(root, "etc", "layout.json"))) {
            File.unlinkSync(join(root, "etc", "layout.json"));
        }

        File.copySync("/var/hoobs/.migration/layout.json", join(root, "etc", "layout.json"));
    }

    if (File.existsSync("/var/hoobs/.migration/accessories")) {
        console.log("Migrating accessories");

        if (File.existsSync(join(root, "etc", "accessories"))) {
            File.unlinkSync(join(root, "etc", "accessories"));
        }

        File.copySync("/var/hoobs/.migration/accessories", join(root, "etc", "accessories"));
    }

    if (File.existsSync("/var/hoobs/.migration/persist")) {
        console.log("Migrating persist");

        if (File.existsSync(join(root, "etc", "persist"))) {
            File.unlinkSync(join(root, "etc", "persist"));
        }

        File.copySync("/var/hoobs/.migration/persist", join(root, "etc", "persist"));
    }

    if (File.existsSync("/var/hoobs/.migration/unmanaged.json")) {
        const unmanaged = tryParseFile("/var/hoobs/.migration/unmanaged.json", []);

        for (let i = 0; i < unmanaged.length; i++) {
            console.log(`Migrating ${unmanaged[i]}`);

            if (File.existsSync(join(root, "etc", unmanaged[i]))) {
                File.unlinkSync(join(root, "etc", unmanaged[i]));
            }

            File.copySync(join("/var/hoobs/.migration", unmanaged[i]), join(root, "etc", unmanaged[i]));
        }
    }
};

const execSudo = function(password, options) {
    return new Promise((resolve) => {
        let prompts = 0;

        let args = [
            "-S",
            "-k",
            "-p",
            "#sudo-hoobs#"
        ];

        args = args.concat(options);

        const proc = spawn("sudo", args);

        proc.stderr.on("data", (data) => {
            const lines = `${data}`.split(/\r?\n/);

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();

                if (line === "#sudo-hoobs#") {
                    if (++prompts > 1) {
                        proc.stdin.write("\n\n\n\n");
                    } else {
                        proc.stdin.write(`${password || ""}\n`);
                    }
                }
            }
        });

        proc.on("close", () => {
            resolve();
        });
    });
};

const checksum = function(root, executing, installed) {
    if (File.existsSync(join(root, "backups"))) {
        File.removeSync(join(root, "backups"));
    }

    File.ensureDirSync(join(root, "backups"));

    if (executing.version !== installed.version) {
        return false;
    }

    if (File.existsSync(join(root, "dist"))) {
        return false;
    }

    if (File.existsSync(join(root, "node_modules", "@hoobs", "hoobs"))) {
        return false;
    }

    return true;
};
