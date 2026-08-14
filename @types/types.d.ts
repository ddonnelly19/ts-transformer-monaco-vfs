type RunTransformer = ({ source, transformCode, compilerOptions, }: {
	source: string;
	transformCode: string;
	compilerOptions?: Partial<import("typescript").CompilerOptions> | undefined;
}) => Promise<{
	transformedTs: string;
	emittedJs: string;
	dts: string;
	errors: {
		message: string;
		error: any;
	}[];
	errorPositions: {
		line: number;
		column: number;
		message: string;
	}[];
}>

type ProgramTransformer = (program: import("typescript").Program) => import("typescript").TransformerFactory<import("typescript").SourceFile>