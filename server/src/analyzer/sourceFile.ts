/*
* sourceFile.ts
* Copyright (c) Microsoft Corporation.
* Licensed under the MIT license.
* Author: Eric Traut
*
* Class that represents a source file.
*/

import * as assert from 'assert';
import * as fs from 'fs';
import { CompletionList } from 'vscode-languageserver';

import { ConfigOptions, ExecutionEnvironment } from '../common/configOptions';
import { ConsoleInterface, StandardConsole } from '../common/console';
import { Diagnostic, DiagnosticCategory, DiagnosticTextPosition, DocumentTextRange } from '../common/diagnostic';
import { DiagnosticSink, TextRangeDiagnosticSink } from '../common/diagnosticSink';
import { getFileName } from '../common/pathUtils';
import { TextRange } from '../common/textRange';
import { TextRangeCollection } from '../common/textRangeCollection';
import { timingStats } from '../common/timing';
import { ModuleNode } from '../parser/parseNodes';
import { ParseOptions, Parser, ParseResults } from '../parser/parser';
import { Token } from '../parser/tokenizerTypes';
import { TestWalker } from '../tests/testWalker';
import { AnalyzerFileInfo, ImportMap } from './analyzerFileInfo';
import { AnalyzerNodeInfo } from './analyzerNodeInfo';
import { CircularDependency } from './circularDependency';
import { CompletionProvider } from './completionProvider';
import { DefinitionProvider } from './definitionProvider';
import { HoverProvider } from './hoverProvider';
import { ImportResolver } from './importResolver';
import { ImportResult } from './importResult';
import { ParseTreeCleanerWalker } from './parseTreeCleaner';
import { ModuleImport, PostParseWalker } from './postParseWalker';
import { Scope } from './scope';
import { ModuleScopeAnalyzer } from './semanticAnalyzer';
import { TypeAnalyzer } from './typeAnalyzer';

const MaxImportCyclesPerFile = 4;

export enum AnalysisPhase {
    Parse = 0,
    SemanticAnalysis = 1,
    TypeAnalysis = 2,

    FirstAnalysisPhase = SemanticAnalysis,
    LastAnalysisPhase = TypeAnalysis
}

// Represents a pending or completed parse or analysis operation.
export interface AnalysisJob {
    fileContentsVersion: number;
    nextPhaseToRun: AnalysisPhase;
    parseTreeNeedsCleaning: boolean;
    parseResults?: ParseResults;

    parseDiagnostics: Diagnostic[];
    semanticAnalysisDiagnostics: Diagnostic[];
    typeAnalysisLastPassDiagnostics: Diagnostic[];
    typeAnalysisFinalDiagnostics: Diagnostic[];

    circularDependencies: CircularDependency[];

    typeAnalysisPassNumber: number;
    isTypeAnalysisPassNeeded: boolean;
    isTypeAnalysisFinalized: boolean;

    imports?: ImportResult[];
    builtinsImport?: ImportResult;
    typingModulePath?: string;
}

export class SourceFile {
    // Console interface to use for debugging.
    private _console: ConsoleInterface;

    // File path on disk.
    private readonly _filePath: string;

    // True if file is a type-hint (.pyi) file versus a python
    // (.py) file.
    private readonly _isStubFile: boolean;

    // True if the file is a typeshed stub file.
    private readonly _isTypeshedStubFile: boolean;

    // True if the file is the "typing.pyi" file, which needs
    // special-case handling.
    private readonly _isTypingStubFile: boolean;

    // True if the file one of the other built-in stub files
    // that require special-case handling: "collections.pyi",
    // "dataclasses.pyi", "abc.pyi", "asyncio/coroutines.pyi".
    private readonly _isBuiltInStubFile: boolean;

    // Latest analysis job that has completed at least one phase
    // of analysis.
    private _analysisJob: AnalysisJob = {
        fileContentsVersion: -1,
        nextPhaseToRun: AnalysisPhase.SemanticAnalysis,
        parseTreeNeedsCleaning: false,

        parseDiagnostics: [],
        semanticAnalysisDiagnostics: [],
        typeAnalysisLastPassDiagnostics: [],
        typeAnalysisFinalDiagnostics: [],

        circularDependencies: [],

        typeAnalysisPassNumber: 1,
        isTypeAnalysisPassNeeded: true,
        isTypeAnalysisFinalized: false
    };

    // Number that is incremented every time the diagnostics
    // are updated.
    private _diagnosticVersion = 0;

    // Generation count of the file contents. When the contents
    // change, this is incremented.
    private _fileContentsVersion = 0;

    // Client's version of the file. Null implies that contents
    // need to be read from disk.
    private _clientVersion: number | null = null;

    // In-memory contents if sent from the language client. If
    // clientVersion is null, we'll ignore this and read the
    // contents from disk.
    private _fileContents: string | undefined;

    constructor(filePath: string, isTypeshedStubFile: boolean, console?: ConsoleInterface) {
        this._console = console || new StandardConsole();
        if (this._console) {
            // This is here to prevent the compiler from complaining
            // about an unused instance variable.
        }
        this._filePath = filePath;
        this._isStubFile = filePath.endsWith('.pyi');
        this._isTypeshedStubFile = isTypeshedStubFile;
        const fileName = getFileName(filePath);
        this._isTypingStubFile = this._isStubFile && (
            fileName === 'typing.pyi' || fileName === 'typing_extensions.pyi');

        this._isBuiltInStubFile = false;
        if (this._isStubFile) {
            if (this._filePath.endsWith('/collections/__init__.pyi') ||
                    fileName === 'dataclasses.pyi' ||
                    fileName === 'abc.pyi') {

                this._isBuiltInStubFile = true;
            }
        }
    }

    getFilePath(): string {
        return this._filePath;
    }

    getDiagnosticVersion(): number {
        return this._diagnosticVersion;
    }

    isStubFile() {
        return this._isStubFile;
    }

    // Returns a list of cached diagnostics from the latest analysis job.
    // If the prevVersion is specified, the method returns undefined if
    // the diagnostics haven't changed.
    getDiagnostics(options: ConfigOptions, prevDiagnosticVersion?: number):
            Diagnostic[] | undefined {

        if (this._diagnosticVersion === prevDiagnosticVersion) {
            return undefined;
        }

        let diagList: Diagnostic[] = [];
        diagList = diagList.concat(
            this._analysisJob.parseDiagnostics,
            this._analysisJob.semanticAnalysisDiagnostics,
            this._analysisJob.typeAnalysisFinalDiagnostics);

        if (options.reportImportCycles !== 'none' && this._analysisJob.circularDependencies.length > 0) {
            const category = options.reportImportCycles === 'warning' ?
                DiagnosticCategory.Warning : DiagnosticCategory.Error;

            this._analysisJob.circularDependencies.forEach(cirDep => {
                diagList.push(new Diagnostic(category, 'Cycle detected in import chain\n' +
                    cirDep.getPaths().map(path => '  ' + path).join('\n')));
            });
        }

        if (this._isTypeshedStubFile) {
            if (options.reportTypeshedErrors === 'none') {
                return undefined;
            } else if (options.reportTypeshedErrors === 'warning') {
                // Convert all the errors to warnings.
                diagList = diagList.map(diag => {
                    if (diag.category === DiagnosticCategory.Error) {
                        return new Diagnostic(DiagnosticCategory.Warning,
                            diag.message, diag.range);
                    }
                    return diag;
                });
            }
        }

        // If the file is in the ignore list, clear the diagnostic list.
        if (options.ignore.find(ignorePath => this._filePath.startsWith(ignorePath))) {
            diagList = [];
        }

        return diagList;
    }

    getImports(): ImportResult[] {
        return this._analysisJob.imports || [];
    }

    getBuiltinsImport(): ImportResult | undefined {
        return this._analysisJob.builtinsImport;
    }

    markDirty(): void {
        this._fileContentsVersion++;
        this._analysisJob.isTypeAnalysisFinalized = false;
        this._analysisJob.nextPhaseToRun = AnalysisPhase.SemanticAnalysis;
    }

    markReanalysisRequired(): void {
        // Keep the parse info, but reset the analysis to the beginning.
        this._analysisJob.nextPhaseToRun = AnalysisPhase.SemanticAnalysis;
        this._analysisJob.parseTreeNeedsCleaning = true;
        this._analysisJob.isTypeAnalysisFinalized = false;
    }

    setClientVersion(version: number | null, contents: string): void {
        this._clientVersion = version;

        if (version === null) {
            this._fileContents = undefined;
        } else {
            if (this._fileContents !== undefined) {
                if (this._fileContents !== contents) {
                    this.markDirty();
                }
            }

            this._fileContents = contents;
        }
    }

    prepareForClose() {
        // Nothing to do currently.
    }

    isParseRequired() {
        return this._analysisJob.fileContentsVersion !== this._fileContentsVersion;
    }

    isSemanticAnalysisRequired() {
        if (this.isParseRequired()) {
            return true;
        }

        return this._analysisJob.nextPhaseToRun <= AnalysisPhase.SemanticAnalysis;
    }

    isTypeAnalysisRequired() {
        if (this.isSemanticAnalysisRequired()) {
            return true;
        }

        // If the analysis is complete, no more analysis is required.
        if (this._analysisJob.nextPhaseToRun < AnalysisPhase.TypeAnalysis ||
                this._analysisJob.isTypeAnalysisPassNeeded) {
            return true;
        }

        return false;
    }

    isAnalysisFinalized() {
        return !this.isTypeAnalysisRequired() && this._analysisJob.isTypeAnalysisFinalized;
    }

    getParseResults(): ParseResults | undefined {
        if (!this.isParseRequired()) {
            return this._analysisJob.parseResults;
        }

        return undefined;
    }

    // Adds a new circular dependency for this file but only if
    // it hasn't already been added.
    addCircularDependency(circDependency: CircularDependency) {
        // Some topologies can result in a massive number of cycles. We'll cut it off.
        if (this._analysisJob.circularDependencies.length < MaxImportCyclesPerFile) {
            if (!this._analysisJob.circularDependencies.some(dep => dep.isEqual(circDependency))) {
                this._analysisJob.circularDependencies.push(circDependency);
            }
        }
    }

    // Parse the file and update the state. Callers should wait for completion
    // (or at least cancel) prior to calling again. It returns true if a parse
    // was required and false if the parse information was up to date already.
    parse(configOptions: ConfigOptions): boolean {
        // If the file is already parsed, we can skip.
        if (!this.isParseRequired()) {
            return false;
        }

        let diagSink = new DiagnosticSink();
        let fileContents = this._fileContents;
        if (this._clientVersion === null) {
            try {
                timingStats.readFileTime.timeOperation(() => {
                    // Read the file's contents.
                    fileContents = fs.readFileSync(this._filePath, { encoding: 'utf8' });
                });
            } catch (error) {
                diagSink.addError(`Source file could not be read`);
                fileContents = '';
            }
        }

        // Use the configuration options to determine the environment in which
        // this source file will be executed.
        let execEnvironment = configOptions.findExecEnvironment(this._filePath);

        let parseOptions = new ParseOptions();
        if (this._filePath.endsWith('pyi')) {
            parseOptions.isStubFile = true;
        }
        parseOptions.pythonVersion = execEnvironment.pythonVersion;

        try {
            // Parse the token stream, building the abstract syntax tree.
            let parser = new Parser();
            let parseResults = parser.parseSourceFile(fileContents!, parseOptions, diagSink);

            // Convert the diagnostic sink into one that knows how to convert
            // to line numbers.
            let textRangeDiagSink = new TextRangeDiagnosticSink(parseResults.lines, diagSink.diagnostics);

            // Fill in the parent links and get the list of imports.
            let walker = new PostParseWalker(textRangeDiagSink, parseResults.parseTree);
            timingStats.postParseWalkerTime.timeOperation(() => {
                walker.analyze();
            });

            // If we're in "test mode" (used for unit testing), run an additional
            // "test walker" over the parse tree to validate its internal consistency.
            if (configOptions.internalTestMode) {
                let testWalker = new TestWalker();
                testWalker.walk(parseResults.parseTree);
            }

            // Save information in the analysis job.
            this._analysisJob.parseResults = parseResults;
            [this._analysisJob.imports, this._analysisJob.builtinsImport, this._analysisJob.typingModulePath] =
                this._resolveImports(walker.getImportedModules(), configOptions, execEnvironment);
            this._analysisJob.parseDiagnostics = diagSink.diagnostics;
        } catch (e) {
            let message: string;
            if (e instanceof Error) {
                message = e.message;
            } else {
                message = JSON.stringify(e);
            }

            this._console.log(
                `An internal error occurred while parsing ${ this.getFilePath() }: ` + message);

            this._analysisJob.parseResults = {
                parseTree: new ModuleNode(new TextRange(0, 0)),
                tokens: new TextRangeCollection<Token>([]),
                lines: new TextRangeCollection<TextRange>([])
            };
            this._analysisJob.imports = undefined;
            this._analysisJob.builtinsImport = undefined;

            const diagSink = new DiagnosticSink();
            diagSink.addError(`An internal error occurred while parsing file`);
            this._analysisJob.parseDiagnostics = diagSink.diagnostics;
        }

        this._analysisJob.fileContentsVersion = this._fileContentsVersion;
        this._analysisJob.nextPhaseToRun = AnalysisPhase.SemanticAnalysis;
        this._analysisJob.parseTreeNeedsCleaning = false;
        this._diagnosticVersion++;

        return true;
    }

    getDefinitionForPosition(position: DiagnosticTextPosition): DocumentTextRange | undefined {
        // If we have no completed analysis job, there's nothing to do.
        if (!this._analysisJob.parseResults) {
            return undefined;
        }

        return DefinitionProvider.getDefinitionForPosition(
                this._analysisJob.parseResults, position);
    }

    getHoverForPosition(position: DiagnosticTextPosition): string | undefined {
        // If we have no completed analysis job, there's nothing to do.
        if (!this._analysisJob.parseResults) {
            return undefined;
        }

        return HoverProvider.getHoverForPosition(
                this._analysisJob.parseResults, position);
    }

    getCompletionsForPosition(position: DiagnosticTextPosition): CompletionList | undefined {
        // If we have no completed analysis job, there's nothing to do.
        if (!this._analysisJob.parseResults) {
            return undefined;
        }

        // This command should be called only for open files, in which
        // case we should have the file contents already loaded.
        if (this._fileContents === undefined) {
            return undefined;
        }

        return CompletionProvider.getCompletionsForPosition(
                this._analysisJob.parseResults, this._fileContents, position);
    }

    getAnalysisPassCount() {
        return this._analysisJob.typeAnalysisPassNumber;
    }

    setTypeAnalysisPassNeeded() {
        this._analysisJob.isTypeAnalysisPassNeeded = true;
        this._analysisJob.isTypeAnalysisFinalized = false;
    }

    doSemanticAnalysis(configOptions: ConfigOptions, builtinsScope?: Scope) {
        assert(!this.isParseRequired());
        assert(this.isSemanticAnalysisRequired());
        assert(this._analysisJob.parseResults);
        assert(this._analysisJob.nextPhaseToRun === AnalysisPhase.SemanticAnalysis);

        const fileInfo = this._buildFileInfo(configOptions, undefined, builtinsScope);

        try {
            this._cleanParseTreeIfRequired();

            // Perform semantic analysis.
            let scopeAnalyzer = new ModuleScopeAnalyzer(
                this._analysisJob.parseResults!.parseTree, fileInfo);
            timingStats.semanticAnalyzerTime.timeOperation(() => {
                scopeAnalyzer.analyze();
            });

            this._analysisJob.semanticAnalysisDiagnostics = fileInfo.diagnosticSink.diagnostics;
        } catch (e) {
            let message: string;
            if (e instanceof Error) {
                message = e.message;
            } else {
                message = JSON.stringify(e);
            }

            this._console.log(
                `An internal error occurred while performing semantic analysis for ${ this.getFilePath() }: ` + message);

            const diagSink = new DiagnosticSink();
            diagSink.addError(`An internal error occurred while performing semantic analysis`);
            this._analysisJob.semanticAnalysisDiagnostics = diagSink.diagnostics;
        }

        // Prepare for the next stage of the analysis.
        this._analysisJob.nextPhaseToRun = AnalysisPhase.TypeAnalysis;
        this._diagnosticVersion++;
        this._analysisJob.typeAnalysisPassNumber = 1;
        this._analysisJob.circularDependencies = [];
        this._analysisJob.isTypeAnalysisPassNeeded = true;
        this._analysisJob.isTypeAnalysisFinalized = false;
        this._analysisJob.nextPhaseToRun = AnalysisPhase.TypeAnalysis;
    }

    doTypeAnalysis(configOptions: ConfigOptions, importMap: ImportMap) {
        assert(!this.isParseRequired());
        assert(!this.isSemanticAnalysisRequired());
        assert(this.isTypeAnalysisRequired());
        assert(this._analysisJob.parseResults);
        assert(this._analysisJob.nextPhaseToRun === AnalysisPhase.TypeAnalysis);

        const fileInfo = this._buildFileInfo(configOptions, importMap, undefined);

        try {
            // Perform static type analysis.
            let typeAnalyzer = new TypeAnalyzer(this._analysisJob.parseResults!.parseTree,
                fileInfo, this._analysisJob.typeAnalysisPassNumber);
            this._analysisJob.typeAnalysisPassNumber++;

            timingStats.typeAnalyzerTime.timeOperation(() => {
                // Repeatedly call the analyzer until everything converges.
                this._analysisJob.isTypeAnalysisPassNeeded = typeAnalyzer.analyze();
                this._analysisJob.typeAnalysisLastPassDiagnostics = fileInfo.diagnosticSink.diagnostics;
            });
        } catch (e) {
            let message: string;
            if (e instanceof Error) {
                message = e.message;
            } else {
                message = JSON.stringify(e);
            }

            this._console.log(
                `An internal error occurred while while performing type analysis for ${ this.getFilePath() }: ` + message);
            const diagSink = new DiagnosticSink();
            diagSink.addError(`An internal error occurred while performing type analysis`);

            // Mark the file as complete so we don't get into an infinite loop.
            this._analysisJob.isTypeAnalysisPassNeeded = false;
            this._analysisJob.typeAnalysisLastPassDiagnostics = diagSink.diagnostics;
        }
    }

    // This method should be called once type analysis has completed for
    // this file and all of its dependent files.
    finalizeAnalysis() {
        assert(!this.isTypeAnalysisRequired());

        // Mark the type analysis as final.
        this._analysisJob.isTypeAnalysisFinalized = true;

        // Finalize the diagnostics from the last pass of type analysis
        // so they become visible.
        this._analysisJob.typeAnalysisFinalDiagnostics =
            this._analysisJob.typeAnalysisLastPassDiagnostics;
        this._analysisJob.typeAnalysisLastPassDiagnostics = [];
        this._diagnosticVersion++;
    }

    private _buildFileInfo(configOptions: ConfigOptions, importMap?: ImportMap, builtinsScope?: Scope) {
        assert(this._analysisJob.parseResults !== undefined);
        let analysisDiagnostics = new TextRangeDiagnosticSink(this._analysisJob.parseResults!.lines);

        let fileInfo: AnalyzerFileInfo = {
            importMap: importMap || {},
            builtinsScope,
            typingModulePath: this._analysisJob.typingModulePath,
            diagnosticSink: analysisDiagnostics,
            executionEnvironment: configOptions.findExecEnvironment(this._filePath),
            configOptions,
            lines: this._analysisJob.parseResults!.lines,
            filePath: this._filePath,
            isStubFile: this._isStubFile,
            isTypingStubFile: this._isTypingStubFile,
            isBuiltInStubFile: this._isBuiltInStubFile,
            console: this._console
        };
        return fileInfo;
    }

    private _cleanParseTreeIfRequired() {
        if (this._analysisJob && this._analysisJob.parseResults) {
            if (this._analysisJob.parseTreeNeedsCleaning) {
                let cleanerWalker = new ParseTreeCleanerWalker(
                    this._analysisJob.parseResults.parseTree);
                cleanerWalker.clean();
                this._analysisJob.parseTreeNeedsCleaning = false;
            }
        }
    }

    private _resolveImports(moduleImports: ModuleImport[],
            configOptions: ConfigOptions, execEnv: ExecutionEnvironment):
            [ImportResult[], ImportResult?, string?] {
        let imports: ImportResult[] = [];

        let resolver = new ImportResolver(this._filePath, configOptions, execEnv);

        // Always include an implicit import of the builtins module.
        let builtinsImportResult: ImportResult | undefined = resolver.resolveImport({
            leadingDots: 0,
            nameParts: ['builtins'],
            importedSymbols: undefined
        });

        // Avoid importing builtins from the builtins.pyi file itself.
        if (builtinsImportResult.resolvedPaths.length === 0 ||
                builtinsImportResult.resolvedPaths[0] !== this.getFilePath()) {
            imports.push(builtinsImportResult);
        } else {
            builtinsImportResult = undefined;
        }

        // Always include an implicit import of the typing module.
        let typingImportResult: ImportResult | undefined = resolver.resolveImport({
            leadingDots: 0,
            nameParts: ['typing'],
            importedSymbols: undefined
        });

        // Avoid importing typing from the typing.pyi file itself.
        let typingModulePath: string | undefined;
        if (typingImportResult.resolvedPaths.length === 0 ||
                typingImportResult.resolvedPaths[0] !== this.getFilePath()) {
            imports.push(typingImportResult);
            typingModulePath = typingImportResult.resolvedPaths[0];
        }

        for (const moduleImport of moduleImports) {
            let importResult = resolver.resolveImport({
                leadingDots: moduleImport.leadingDots,
                nameParts: moduleImport.nameParts,
                importedSymbols: moduleImport.importedSymbols
            });
            imports.push(importResult);

            // Associate the import results with the module import
            // name node in the parse tree so we can access it later
            // (for hover and definition support).
            AnalyzerNodeInfo.setImportInfo(moduleImport.nameNode, importResult);
        }

        return [imports, builtinsImportResult, typingModulePath];
    }
}
