// Shared functions
"use strict";

const debug = require("debug")("npm-groovy-lint");
const fse = require("fs-extra");
const os = require("os");
const path = require("path");
const { getConfigFileName } = require("./config.js");
const { collectDisabledBlocks, isFilteredError } = require("./filter.js");
const { getNpmGroovyLintRules } = require("./groovy-lint-rules.js");
const { evaluateRange, evaluateVariables, getSourceLines, normalizeNewLines } = require("./utils.js");

////////////////////////////
// Build codenarc options //
////////////////////////////

const npmGroovyLintRules = getNpmGroovyLintRules();
const CODENARC_TMP_FILENAME_BASE = "codeNarcTmpDir_";
const CODENARC_WWW_BASE = "https://codenarc.github.io/CodeNarc";

// Convert NPM-groovy-lint into codeNarc arguments
// Create temporary files if necessary
async function prepareCodeNarcCall(options) {
    const result = { codenarcArgs: [] };

    let cnPath = options.path;
    let cnFiles = options.files;

    // If source option, create a temporary Groovy file
    if (options.source) {
        cnPath = path.resolve(os.tmpdir() + "/npm-groovy-lint");
        await fse.ensureDir(cnPath, { mode: "0777" });
        // File path is sent (recommended): use it to create temp file name
        if (options.sourcefilepath) {
            const pathParse = path.parse(options.sourcefilepath);
            cnPath = cnPath + "/codeNarcTmpDir_" + Math.random();
            await fse.ensureDir(cnPath, { mode: "0777" });
            result.tmpGroovyFileName = path.resolve(cnPath + "/" + pathParse.base);
            cnFiles = "**/" + pathParse.base;
        }
        // Use default random file name
        else {
            const tmpFileNm = CODENARC_TMP_FILENAME_BASE + Math.random() + ".groovy";
            result.tmpGroovyFileName = path.resolve(cnPath + "/" + tmpFileNm);
            cnFiles = "**/" + tmpFileNm;
        }

        await fse.writeFile(result.tmpGroovyFileName, normalizeNewLines(options.source));
        debug(`CREATE GROOVY temp file ${result.tmpGroovyFileName} with input source, as CodeNarc requires physical files`);
    }

    // Define base directory
    const baseBefore = (cnPath !== "." && cnPath.startsWith("/")) || cnPath.includes(":/") || cnPath.includes(":\\") ? "" : process.cwd() + "/";
    result.codeNarcBaseDir = cnPath !== "." ? baseBefore + cnPath.replace(/^"(.*)"$/, "$1") : process.cwd();
    result.codeNarcBaseDir = path.resolve(result.codeNarcBaseDir);
    result.codenarcArgs.push(`-basedir=${result.codeNarcBaseDir}`);

    // Create ruleSet groovy file if necessary
    const ruleSetFileName = await manageCreateRuleSetFile(options);
    options.rulesets = ruleSetFileName;
    if (ruleSetFileName.includes("codeNarcTmpRs_")) {
        result.tmpRuleSetFileName = ruleSetFileName;
    }

    // Build ruleSet & file CodeNarc arguments
    let defaultFilesPattern = "**/*.groovy,**/Jenkinsfile,**/*.gradle";

    // RuleSet codeNarc arg
    const rulesetFileArgs = options.rulesets.startsWith("file:") ? options.rulesets : `file:${options.rulesets.replace(/^"(.*)"$/, "$1")}`;

    result.codenarcArgs.push(`-rulesetfiles=${rulesetFileArgs}`);

    // Matching files pattern(s)
    if (cnFiles) {
        const normalizedCnFiles = cnFiles.replace(/^"(.*)"$/, "$1");
        result.codenarcArgs.push(`-includes=${normalizedCnFiles}`);
        result.codeNarcIncludes = normalizedCnFiles;
    } else {
        // If files not sent, use defaultFilesPattern, guessed from options.rulesets value
        result.codenarcArgs.push(`-includes=${defaultFilesPattern}`);
        result.codeNarcIncludes = defaultFilesPattern;
    }

    // Ignore pattern
    if (options.ignorepattern) {
        result.codenarcArgs.push(`-excludes=${options.ignorepattern}`);
        result.codeNarcExcludes = options.ignorepattern;
    }

    // Output
    result.output = options.output.replace(/^"(.*)"$/, "$1");
    if (["txt", "json", "none"].includes(result.output) || result.output.endsWith(".txt") || result.output.endsWith(".json")) {
        result.outputType = result.output.endsWith(".txt") ? "txt" : result.output.endsWith(".json") ? "json" : result.output;
        result.codenarcArgs.push(`-report=json:stdout`);
    } else if (["html", "xml"].includes(result.output.split(".").pop())) {
        result.outputType = result.output
            .split(".")
            .pop()
            .endsWith("html")
            ? "html"
            : result.output
                  .split(".")
                  .pop()
                  .endsWith("xml")
            ? "xml"
            : "";
        const ext = result.output.split(".").pop();
        result.codenarcArgs.push(`-report=${ext}:${result.output}`);

        // If filename is sent: just call codeNarc, no parsing results
        if (!["html", "xml"].includes(result.output)) {
            result.onlyCodeNarc = true;
        }
    } else {
        result.status = 2;
        const errMsg = `Output not managed: ${result.output}. (For now, only output formats are txt and json in console, and html and xml as files)`;
        console.error(errMsg);
        result.error = {
            msg: errMsg
        };
    }
    return result;
}

// Parse XML result file as js object
async function parseCodeNarcResult(options, codeNarcBaseDir, codeNarcJsonResult, tmpGroovyFileName, parseErrors) {
    if (!codeNarcJsonResult || !codeNarcJsonResult.codeNarc || !codeNarcJsonResult.packages) {
        const errMsg = `Unable to use CodeNarc JSON result\n ${JSON.stringify(codeNarcJsonResult)}`;
        console.error(errMsg);
        return {
            status: 2,
            error: {
                msg: errMsg
            }
        };
    }
    const result = { summary: {} };

    // Parse main result
    const pckgSummary = codeNarcJsonResult.summary;
    result.summary.totalFilesWithErrorsNumber = parseInt(pckgSummary.filesWithViolations, 10);
    result.summary.totalFilesLinted = parseInt(pckgSummary.totalFiles, 10);
    result.summary.totalFoundErrorNumber = parseInt(pckgSummary.priority1, 10);
    result.summary.totalFoundWarningNumber = parseInt(pckgSummary.priority2, 10);
    result.summary.totalFoundInfoNumber = parseInt(pckgSummary.priority3, 10);

    const tmpGroovyFileNameReplace =
        tmpGroovyFileName && tmpGroovyFileName.includes(CODENARC_TMP_FILENAME_BASE) ? path.resolve(tmpGroovyFileName) : null;

    // Parse files & violations
    const files = {};
    let errId = 0;

    // Manage parse errors (returned by CodeNarcServer, not CodeNarc)
    if (parseErrors && Object.keys(parseErrors).length > 0) {
        for (const fileNm1 of Object.keys(parseErrors)) {
            const fileParseErrors = parseErrors[fileNm1];
            const fileNm = options.source ? 0 : path.resolve(fileNm1);
            if (files[fileNm] == null) {
                files[fileNm] = { errors: [] };
            }
            for (const parseError of fileParseErrors) {
                // Convert GroovyShell.parse Compilation exception error into NpmGroovyLint exception
                let msg =
                    parseError.cause && parseError.cause.message ? parseError.cause.message : `Unknown parsing error: ${JSON.stringify(parseError)}`;
                // Remove 'unable to resolve class' error as GroovyShell.parse is called without ClassPath
                if (msg.startsWith("unable to resolve class ")) {
                    continue;
                }
                // Create new error
                const errItemParse = {
                    id: errId,
                    line: parseError.cause && parseError.cause.line ? parseError.cause.line : 0,
                    rule: "NglParseError",
                    severity: "error",
                    msg: msg
                };
                // Add range if provided
                if (parseError.cause && parseError.cause.startColumn) {
                    errItemParse.range = {
                        start: { line: parseError.cause.startLine, character: parseError.cause.startColumn },
                        end: { line: parseError.cause.endLine, character: parseError.cause.endColumn }
                    };
                }

                files[fileNm].errors.push(errItemParse);
                errId++;
            }
        }
    }

    // Extract CodeNarc reported errors
    for (const packageInfo of codeNarcJsonResult.packages) {
        for (const fileInfo of packageInfo.files) {
            // Build file name, or use '0' if source has been sent as input parameter
            const fileNm = options.source
                ? 0
                : path.resolve(codeNarcBaseDir + "/" + (packageInfo.path ? packageInfo.path + "/" : "") + fileInfo.name);
            if (files[fileNm] == null) {
                files[fileNm] = { errors: [] };
            }

            // Get source code from file or input parameter
            let allLines = await getSourceLines(options.source, fileNm);

            // Get groovylint disabled blocks and rules in source comments
            const disabledBlocks = collectDisabledBlocks(allLines);

            // Browse CodeNarc XML file reported errors
            for (const violation of fileInfo.violations) {
                const errItem = {
                    id: errId,
                    line: violation.lineNumber ? parseInt(violation.lineNumber, 10) : 0,
                    rule: violation.ruleName,
                    severity:
                        violation.priority === 1 ? "error" : violation.priority === 2 ? "warning" : violation.priority === 3 ? "info" : "unknown",
                    msg: violation.message ? violation.message : ""
                };
                errItem.msg = tmpGroovyFileNameReplace ? errItem.msg.replace(tmpGroovyFileNameReplace, "") : errItem.msg;

                // Check if error must be filtered because of comments
                if (isFilteredError(errItem, allLines, disabledBlocks)) {
                    continue;
                }

                // Find range & add error only if severity is matching logLevel
                if (
                    errItem.severity === "error" ||
                    options.loglevel === "info" ||
                    (options.loglevel === "warning" && ["error", "warning"].includes(errItem.severity))
                ) {
                    // Get fixable info & range if they have been defined on the rule
                    const errRule = npmGroovyLintRules[errItem.rule];
                    if (errRule) {
                        if (errRule.fix) {
                            errItem.fixable = true;
                            errItem.fixLabel = errRule.fix.label || `Fix ${errItem.rule}`;
                        }
                        if (errRule.range) {
                            const evaluatedVars = evaluateVariables(errRule.variables, errItem.msg, { verbose: options.verbose });
                            const errLine = allLines[errItem.line - 1];
                            const range = evaluateRange(errItem, errRule, evaluatedVars, errLine, allLines, { verbose: options.verbose });
                            if (range) {
                                errItem.range = range;
                            }
                        }
                    }
                    // Add in file errors
                    files[fileNm].errors.push(errItem);
                    errId++;
                }
            }
        }
    }
    result.files = files;
    // Add tmp file if no errors and source argument  used
    if (Object.keys(result.files).length === 0 && tmpGroovyFileName) {
        result.files[0] = { errors: [] };
    }

    // Parse error definitions & build url if not already done and not noreturnrules option
    if (result.rules == null && options.returnrules === true) {
        const configAllFileName = await getConfigFileName(__dirname, null, [".groovylintrc-all.json"]);
        const grooylintrcAllRules = Object.keys(JSON.parse(fse.readFileSync(configAllFileName, "utf8").toString()).rules);
        const rules = {};
        for (const ruleDef of codeNarcJsonResult.rules) {
            const ruleName = ruleDef.name;
            // Add description from CodeNarc
            rules[ruleName] = { description: ruleDef.description };
            // Try to build codenarc url (ex: https://codenarc.github.io/CodeNarc/codenarc-rules-basic.html#bitwiseoperatorinconditional-rule )
            const matchRules = grooylintrcAllRules.filter(ruleNameX => ruleNameX.split(".")[1] === ruleName);
            if (matchRules && matchRules[0]) {
                const ruleCategory = matchRules[0].split(".")[0];
                const ruleDocUrl = `${CODENARC_WWW_BASE}/codenarc-rules-${ruleCategory}.html#${ruleName.toLowerCase()}-rule`;
                rules[ruleName].docUrl = ruleDocUrl;
            }
        }
        result.rules = rules;
    }

    return result;
}

// Build RuleSet file from configuration
async function manageCreateRuleSetFile(options) {
    // If RuleSet files has already been created, or is groovy file, return it
    if (options.rulesets && (options.rulesets.endsWith(".groovy") || options.rulesets.endsWith(".xml"))) {
        const rulesetSplits = options.rulesets.split(",");
        const normalizedRulesets = rulesetSplits.map(rulesetFile => {
            const fullFile = path.resolve(rulesetFile);
            // Encode file name so CodeNarc understands it
            if (fse.exists(fullFile)) {
                return "file:" + encodeURIComponent(fullFile);
            }
            // File name has already been encoded: let it as it is (will make CodeNarc fail if file not existing)
            return rulesetFile;
        });
        return normalizedRulesets.join(",");
    }

    let ruleSetsDef = [];

    // List of rule strings sent as arguments/options, convert them as ruleSet defs
    if (
        options.rulesets &&
        !options.rulesets.includes(".groovy") &&
        !options.rulesets.includes(".xml") &&
        !options.rulesets.includes("/") &&
        !options.rulesets.includes("\\")
    ) {
        let ruleList = options.rulesets.split(/(,(?!"))/gm).filter(elt => elt !== ",");
        ruleSetsDef = ruleList.map(ruleFromArgument => {
            let ruleName;
            let ruleOptions = {};
            if (ruleFromArgument.includes("{")) {
                // Format "RuleName(param1:"xxx",param2:12)"
                ruleName = ruleFromArgument.substring(0, ruleFromArgument.indexOf("{"));
                const ruleOptionsJson = ruleFromArgument.substring(ruleFromArgument.indexOf("{"));
                ruleOptions = JSON.parse(ruleOptionsJson);
            } else {
                // Format "RuleName"
                ruleName = ruleFromArgument;
            }
            const ruleFromConfig = options.rules[ruleName];
            const mergedRuleConfig =
                typeof ruleFromConfig === "object"
                    ? Object.assign(ruleFromConfig, ruleOptions)
                    : Object.keys(ruleOptions).length > 0
                    ? ruleOptions
                    : ruleFromConfig;
            const ruleDef = buildCodeNarcRule(ruleName, mergedRuleConfig);
            return ruleDef;
        });
    }
    // Rules from config file, only if rulesets has not been sent as argument
    if ((ruleSetsDef.length === 0 || options.rulesetsoverridetype === "appendConfig") && options.rules) {
        for (const ruleName of Object.keys(options.rules)) {
            let ruleDef = options.rules[ruleName];
            // If rule has been overriden in argument, set it on top of config file properties
            const ruleFromRuleSetsArgPos = ruleSetsDef.findIndex(ruleDef => ruleDef.ruleName === ruleName);
            if (ruleFromRuleSetsArgPos > -1) {
                const ruleFromRuleSetsArg = ruleSetsDef[ruleFromRuleSetsArgPos];
                ruleDef =
                    typeof ruleDef === "object"
                        ? Object.assign(ruleDef, ruleFromRuleSetsArg)
                        : Object.keys(ruleFromRuleSetsArg).length > 0
                        ? ruleFromRuleSetsArg
                        : ruleDef;
            }
            // Add in the list of rules to test , except if it is disabled
            if (!(ruleDef === "off" || ruleDef.disabled === true || ruleDef.enabled === false)) {
                const codeNarcRule = buildCodeNarcRule(ruleName, ruleDef);
                if (ruleFromRuleSetsArgPos > -1) {
                    ruleSetsDef[ruleFromRuleSetsArgPos] = codeNarcRule;
                } else {
                    ruleSetsDef.push(codeNarcRule);
                }
            }
        }
    }

    // If ruleSetDef , create temporary RuleSet file
    if (ruleSetsDef && ruleSetsDef.length > 0) {
        // Sort & Create groovy ruleset definition
        ruleSetsDef = ruleSetsDef.sort((a, b) => a.ruleName.localeCompare(b.ruleName));
        let ruleSetSource = `ruleset {\n\n    description 'Generated by npm-groovy-lint (https://github.com/nvuillam/npm-groovy-lint#readme)'\n\n`;
        for (const rule of ruleSetsDef) {
            if (!(npmGroovyLintRules[rule.ruleName] && npmGroovyLintRules[rule.ruleName].isCodeNarcRule === false)) {
                const ruleDeclaration = `    ${rule.ruleName}(${stringifyWithoutPropQuotes(rule)})\n`;
                ruleSetSource += ruleDeclaration;
            }
        }
        ruleSetSource += `\n}\n`;
        // Write file
        await fse.ensureDir(path.resolve(os.tmpdir() + "/npm-groovy-lint"), { mode: "0777" });
        const tmpRuleSetFileName = path.resolve(os.tmpdir() + "/npm-groovy-lint/codeNarcTmpRs_" + Math.random() + ".groovy");
        await fse.writeFile(tmpRuleSetFileName, ruleSetSource);
        debug(`CREATE RULESET tmp file ${tmpRuleSetFileName} generated from input options, as CodeNarc requires physical files`);
        return tmpRuleSetFileName;
    }
}

// Build a CodeNarc rule from groovylint.json config rule
function buildCodeNarcRule(ruleName, ruleFromConfig) {
    const ruleNameShort = ruleName.includes(".") ? ruleName.split(".")[1] : ruleName;
    const codeNarcRule = { ruleName: ruleNameShort };
    // Convert NpmGroovyLint severity into codeNarc priority
    const codeNarcPriorityCode = getCodeNarcPriorityCode(ruleFromConfig || {});
    if (codeNarcPriorityCode) {
        codeNarcRule.priority = codeNarcPriorityCode;
    }
    // Assign extra rule parameters if defined
    if (ruleFromConfig && typeof ruleFromConfig === "object") {
        const propsToAssign = Object.assign({}, ruleFromConfig);
        delete propsToAssign.severity;
        return Object.assign(codeNarcRule, propsToAssign);
    } else {
        return codeNarcRule;
    }
}

// Translate config priority into CodeNarc priority code
function getCodeNarcPriorityCode(ruleFromConfig) {
    if (["error", "err"].includes(ruleFromConfig) || ["error", "err"].includes(ruleFromConfig.severity)) {
        return 1;
    } else if (["warning", "warn"].includes(ruleFromConfig) || ["warning", "warn"].includes(ruleFromConfig.severity)) {
        return 2;
    } else if (["info", "audi"].includes(ruleFromConfig) || ["info", "audi"].includes(ruleFromConfig.severity)) {
        return 3;
    }
    return null;
}

async function manageDeleteTmpFiles(tmpGroovyFileName, tmpRuleSetFileName) {
    // Remove temporary groovy file created for source argument if provided
    if (tmpGroovyFileName) {
        await fse.remove(tmpGroovyFileName);
        debug(`Removed temp file ${tmpGroovyFileName} as it is not longer used`);
        tmpGroovyFileName = null;
    }
    // Remove temporary ruleSet file created for source argument if provided
    if (tmpRuleSetFileName) {
        await fse.remove(tmpRuleSetFileName);
        debug(`Removed temp RuleSet file ${tmpRuleSetFileName} as it is not longer used`);
        tmpRuleSetFileName = null;
    }
}

function stringifyWithoutPropQuotes(obj_from_json) {
    if (typeof obj_from_json !== "object" || Array.isArray(obj_from_json)) {
        // not an object, stringify using native function
        return JSON.stringify(obj_from_json);
    }
    // Implements recursive object serialization according to JSON spec
    // but without quotes around the keys.
    delete obj_from_json.ruleName;
    let props = Object.keys(obj_from_json)
        .map(key => `${key}:${stringifyWithoutPropQuotes(obj_from_json[key])}`)
        .join(",");
    return `${props}`;
}

module.exports = { prepareCodeNarcCall, parseCodeNarcResult, manageDeleteTmpFiles };