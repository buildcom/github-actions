import * as core from '@actions/core';
import * as github from '@actions/github';
import * as minimatch from 'minimatch';
import { Context } from '@actions/github/lib/context';
import { PullRequestEvent, Label as GitHubLabel } from '@octokit/webhooks-types';

const DEBUG = false; // set this to true for extra logging

type File = {
	sha: string;
	filename: string;
	status: string;
	additions: number;
	deletions: number;
	changes: number;
	blob_url: string;
	raw_url: string;
	contents_url: string;
	patch?: string;
	previous_filename?: string;
};

type CustomLabel = {
	name: string;
	color: string;
	type?: string;
	maxLines?: number;
};

type LabelChanges = { labelToAdd: CustomLabel[]; labelsToRemove: GitHubLabel[] };

let context: Context;
const client = github.getOctokit(core.getInput('token'));

const CUSTOM_LABELS: CustomLabel[] = [
	{
		name: 'size/XS',
		type: 'size',
		maxLines: 10,
		color: '3CBF00'
	},
	{
		name: 'size/S',
		type: 'size',
		maxLines: 30,
		color: '5D9801'
	},
	{
		name: 'size/M',
		type: 'size',
		maxLines: 100,
		color: '7F7203'
	},
	{
		name: 'size/L',
		type: 'size',
		maxLines: 500,
		color: 'A14C05'
	},
	{
		name: 'size/XL',
		type: 'size',
		maxLines: 800,
		color: 'C32607'
	},
	{
		name: 'size/XXL',
		type: 'size',
		color: 'E50009'
	},
	{
		name: 'server-only',
		type: 'server-only',
		color: '66E5A2'
	}
];

const MOCK_GLOB_PATTERN = '**/*.+(mocks|mock-data).ts';
const STORY_GLOB_PATTERN = '**/*.story.ts?(x)';
const GITHUB_GLOB_PATTERN = '.github/**';
const HUSKY_GLOB_PATTERN = '.husky/**';
const OUTFILE_GLOB_PATTERN = '.out/**';
const STORYBOOK_GLOB_PATTERN = '.storybook/**';
const VSCODE_GLOB_PATTERN = '.vscode/**';
const FERGY_TEMPLATES_GLOB_PATTERN = 'fergy-templates/**';
const DOCS_GLOB_PATTERN = '**/*.md';
const DOCS_MISC_GLOB_PATTERN = 'doc*/**';
const NON_DEPLOYMENT_GLOB_PATTERNS = [
	MOCK_GLOB_PATTERN,
	STORY_GLOB_PATTERN,
	GITHUB_GLOB_PATTERN,
	HUSKY_GLOB_PATTERN,
	OUTFILE_GLOB_PATTERN,
	STORYBOOK_GLOB_PATTERN,
	VSCODE_GLOB_PATTERN,
	FERGY_TEMPLATES_GLOB_PATTERN,
	DOCS_GLOB_PATTERN,
	DOCS_MISC_GLOB_PATTERN
];

const info = (stuff: string) => core.info(stuff);
const warning = (stuff: string) => core.warning(stuff);
const error = (stuff: string | Error) => {
	if (typeof stuff !== 'string' && stuff.stack) {
		core.error(stuff.stack);
	} else {
		core.error(stuff);
	}
};
const debug = (stuff: string) => DEBUG && core.info(`DEBUG: ${stuff}`);

const sortedSizeLabels = CUSTOM_LABELS.filter((label) => label.type === 'size').sort((a, b) =>
	!a.maxLines ? 1 : !b.maxLines ? -1 : a.maxLines - b.maxLines
);

const getLabelNames = (labels: CustomLabel[] | GitHubLabel[]): string[] => labels.map((label: CustomLabel | GitHubLabel) => label.name);
const getSizeLabel = (lineCount: number): CustomLabel | undefined => {
	for (const label of sortedSizeLabels) {
		if (!label.maxLines || lineCount <= label.maxLines) {
			return label;
		}
	}
	return undefined;
};

const getExcludedGlobs = async () => {
	const path = '.gitattributes';
	const exclusions = ['linguist-generated=true', 'pr-size-ignore=true'];
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const { data }: any = await client.rest.repos.getContent({ ...github.context.repo, path });
		const excludedFiles = data.content
			? Buffer.from(data.content, 'base64')
					.toString('ascii')
					.split('\n')
					.filter((item) => exclusions.some((exclusion) => item.includes(exclusion)))
					.map((item) => item.split(' ')[0])
			: [];
		excludedFiles.length > 0 ? info(`Custom file exclusions found: ${excludedFiles}`) : info('No custom file exclusions found');
		return excludedFiles;
	} catch (e) {
		return [];
	}
};

const ensureLabelExists = async ({ name, color }: CustomLabel) => {
	try {
		return await client.rest.issues.getLabel({ ...github.context.repo, name });
	} catch (e) {
		return client.rest.issues.createLabel({ ...github.context.repo, name, color });
	}
};

const getSizeBasedLabels = async (changedLines: number, files: File[], existingPRLabels: GitHubLabel[]): Promise<LabelChanges> => {
	let totalChangedLines = changedLines;
	let totalChangedLinesInExcludedFiles = 0;
	const excludedGlobs = await getExcludedGlobs();
	for (const file of files) {
		if (excludedGlobs.some((glob) => minimatch(file.filename, glob))) {
			info(`Excluding file: ${file.filename}`);
			totalChangedLines -= file.additions + file.deletions;
			totalChangedLinesInExcludedFiles += file.additions + file.deletions;
		}
	}

	info(`Total number of additions and deletions in excluded files: ${totalChangedLinesInExcludedFiles}`);
	info(`Total number of additions and deletions that will count towards PR size: ${totalChangedLines}`);
	const correctSizeLabel: CustomLabel | undefined = getSizeLabel(totalChangedLines);

	const labelToAdd: CustomLabel[] =
		correctSizeLabel && !existingPRLabels.some((existingLabel) => existingLabel.name === correctSizeLabel.name)
			? [correctSizeLabel]
			: [];

	const labelsToRemove: GitHubLabel[] = [];
	for (const label of existingPRLabels) {
		const isNotCorrectSizeLabel = !(correctSizeLabel && label.name === correctSizeLabel.name);
		const isCustomLabel = sortedSizeLabels.some((sizeLabel) => sizeLabel.name === label.name);
		if (isCustomLabel && isNotCorrectSizeLabel) {
			labelsToRemove.push(label);
		}
	}
	debug(`labelToAdd-size: ${getLabelNames(labelToAdd)} labelsToRemove-size: ${getLabelNames(labelsToRemove)}`);
	return { labelToAdd, labelsToRemove };
};

const getServerOnlyLabel = (files: File[], existingPRLabels: GitHubLabel[]): LabelChanges => {
	const serverOnlyPattern = '**/src/server/**';
	const serverOnlyLabel = CUSTOM_LABELS.find((label) => label.type === 'server-only');
	if (!serverOnlyLabel) {
		return { labelToAdd: [], labelsToRemove: [] };
	}
	for (const file of files) {
		debug(`processing file for server-only: ${file.filename}`);
	}
	const serverOnly = files.length > 0 && !files.some((file) => !minimatch(file.filename, serverOnlyPattern));
	if (serverOnly) {
		info('This PR is server only and has no UI changes');
	} else {
		info('This PR is not server only');
	}

	const existingServerOnlyLabel = existingPRLabels.find((existingLabel) => existingLabel.name === serverOnlyLabel.name);
	const labelToAdd: CustomLabel[] = serverOnly && !existingServerOnlyLabel ? [serverOnlyLabel] : [];
	const labelsToRemove: GitHubLabel[] = !serverOnly && existingServerOnlyLabel ? [existingServerOnlyLabel] : [];
	debug(`labelToAdd-server: ${getLabelNames(labelToAdd)} labelsToRemove-server: ${getLabelNames(labelsToRemove)}`);
	return { labelToAdd, labelsToRemove };
};

const handlePullRequest = async () => {
	const {
		pull_request: { number, title, labels: prLabels, additions, deletions }
	}: PullRequestEvent = context.payload as PullRequestEvent;
	info(`Processing pull request #${number}: ${title} in ${context.repo.repo}`);
	debug(`existingLabels: ${getLabelNames(prLabels)}`);

	const { data: prFiles } = await client.rest.pulls.listFiles({ ...context.repo, pull_number: number });

	const { labelToAdd: sizeLabelToAdd, labelsToRemove: sizeLabelsToRemove } = await getSizeBasedLabels(
		additions + deletions,
		prFiles,
		prLabels
	);
	const { labelToAdd: serverOnlyLabelToAdd, labelsToRemove: serverOnlyLabelToRemove } = getServerOnlyLabel(prFiles, prLabels);

	const labelsToAdd: CustomLabel[] = sizeLabelToAdd.concat(serverOnlyLabelToAdd);
	const labelsToRemove: GitHubLabel[] = sizeLabelsToRemove.concat(serverOnlyLabelToRemove);

	debug(`labels to add: ${getLabelNames(labelsToAdd)}`);
	debug(`labels to remove: ${getLabelNames(labelsToRemove)}`);

	if (labelsToRemove.length > 0) {
		for (const label of labelsToRemove) {
			info(`Removing label ${label.name}`);
			try {
				await client.rest.issues.removeLabel({
					...context.repo,
					issue_number: number,
					name: label.name
				});
			} catch (e) {
				warning(e);
			}
		}
	} else {
		info('No labels to remove');
	}

	if (labelsToAdd.length > 0) {
		info(`Adding labels: ${getLabelNames(labelsToAdd)}`);
		for (const label of labelsToAdd) {
			await ensureLabelExists(label);
		}
		await client.rest.issues.addLabels({
			...context.repo,
			issue_number: number,
			labels: getLabelNames(labelsToAdd)
		});
	} else {
		info('No labels to add');
	}

	const { data: currentLabels } = await client.rest.issues.listLabelsOnIssue({
		...context.repo,
		issue_number: number
	});
	const actionOutputLabels = getLabelNames(currentLabels).toString();
	info(`Action output -- labels: ${actionOutputLabels}`);
	core.setOutput('labels', actionOutputLabels);
};

const handlePushEvent = async () => {
	const commitBeingPushed = context.payload.after;
	const defaultBranch = context.payload.repository.default_branch;
	const getDefaultBranchCommits = await client.rest.repos.listCommits({
		...context.repo
	});
	const defaultBranchHeadCommit = getDefaultBranchCommits.data[0].sha;
	info(`Comparing commit ${defaultBranchHeadCommit} on ${defaultBranch} with ${commitBeingPushed} on ${context.ref}`);
	const compareCommits = await client.rest.repos.compareCommitsWithBasehead({
		basehead: `${defaultBranchHeadCommit}...${commitBeingPushed}`,
		owner: context.repo.owner,
		repo: context.repo.repo
	});
	const files = compareCommits.data.files;
	info(`Files different from ${defaultBranch}: ${files.map((file) => file.filename).join(', ')}`);
	info(`Non-deployment glob patterns: ${NON_DEPLOYMENT_GLOB_PATTERNS.join(', ')}`);
	const skipDeployment = files.every((file) => {
		if (NON_DEPLOYMENT_GLOB_PATTERNS.some((glob) => minimatch(file.filename, glob))) {
			return true;
		}
		info(`Deployable file ${file.filename} found`);
		return false;
	});
	info(`Skip deployment of all files: ${skipDeployment}`);
	core.setOutput('skip-deploy', skipDeployment);
};

const run = async () => {
	try {
		context = github.context;
		if (context.eventName === 'pull_request') {
			await handlePullRequest();
		} else if (context.eventName === 'push') {
			await handlePushEvent();
		} else {
			info(`No relevant event found. Event: ${context.eventName}`);
		}
	} catch (e) {
		error(e);
		return core.setFailed('Something went wrong');
	}
};

run();
