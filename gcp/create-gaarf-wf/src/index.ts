#!/usr/bin/env node
/* eslint-disable no-process-exit */

import * as fs from 'node:fs';
import * as path from 'node:path';
import os from 'node:os';
import child_process from 'child_process';
import minimist from 'minimist';
import inquirer, {Answers, QuestionCollection} from 'inquirer';
import prompts, {PromptType} from 'prompts';
import figlet from 'figlet';
import chalk from 'chalk';
import clui from 'clui';
import yaml from 'js-yaml';

const execSync = child_process.execSync;
const spawn = child_process.spawn;

const GIT_REPO = 'https://github.com/google/ads-api-report-fetcher.git';
const LOG_FILE = '.create-gaarf-wf-out.log';

const argv = minimist(process.argv.slice(2));
const is_diag = argv.diag;
const is_debug = argv.debug || argv.diag;

const cwd = get_cwd(argv);

function get_cwd(argv: minimist.ParsedArgs) {
  // First argument (optional) is a path where the tool run in.
  let cwd = argv._[0];
  if (cwd) {
    if (!path.isAbsolute(cwd)) {
      cwd = path.resolve(process.cwd(), cwd);
    }
    if (!fs.existsSync(cwd)) {
      fs.mkdirSync(cwd);
    }
    process.chdir(cwd);
  } else {
    cwd = process.cwd();
  }
  return cwd;
}

function deploy_shell_script(fileName: string, content: string) {
  fs.writeFileSync(fileName, content);
  execSync(`chmod +x ${fileName}`);
  console.log(chalk.gray(`Created ${fileName}`));
}

function exec_cmd(
  cmd: string,
  spinner?: clui.Spinner | undefined | null,
  options?: {realtime?: boolean; silent?: boolean; keep_output?: boolean}
): Promise<{code: number; stderr: string; stdout: string}> {
  options = options || {};
  if (spinner && options.realtime === undefined) {
    // having a spinner and streaming stdout at the same looks bad
    options.realtime = false;
  }
  if (is_diag) {
    options.keep_output = true;
  }
  if (spinner) spinner.start();
  if (is_debug) {
    console.log(chalk.gray(cmd));
    fs.appendFileSync(LOG_FILE, `[${new Date()}] Running ${cmd}\n`);
  }
  const cp = spawn(cmd, [], {
    shell: true,
    // inherit stdin, and wrap stdout/stderr
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  return new Promise(resolve => {
    let stderr = '';
    let stdout = '';
    cp.stderr?.on('data', chunk => {
      stderr += chunk;
      if (options?.realtime) process.stderr.write(chunk);
    });
    cp.stdout?.on('data', chunk => {
      stdout += chunk;
      if (options?.realtime) process.stdout.write(chunk);
    });
    cp.on('close', (code: number) => {
      if (spinner) spinner.stop();
      if (!spinner && options?.realtime && !options?.keep_output) {
        // if there's no spinner and keep_output=false, remove all output of the command
        const terminal_width = process.stdout.columns;
        let lines = (stdout ? stdout.split(os.EOL) : []).concat(
          stderr ? stderr.split(os.EOL) : []
        );
        lines = lines.map(line => {
          const arr = line.split('\r');
          return arr[arr.length - 1];
        });
        if (lines.length > 0) {
          const row_count = lines
            .map(line => ((line.length / terminal_width) | 0) + 1)
            .reduce((total, count) => (total += count), 0);
          process.stdout.cursorTo(0);
          process.stdout.moveCursor(0, -row_count + 1);
          process.stdout.clearScreenDown();
        }
      }
      if (stderr && !options?.realtime && !options?.silent && code !== 0) {
        // by default, if not switched off and not realtime output, show error
        console.log(stderr);
      }
      if (is_debug) {
        fs.appendFileSync(
          LOG_FILE,
          `[${new Date()}] ${cmd} return ${code} exit code\n`
        );
        fs.appendFileSync(LOG_FILE, stdout + '\n');
        fs.appendFileSync(LOG_FILE, stderr + '\n');
      }
      resolve({
        code,
        stderr: stderr || '',
        stdout: stdout || '',
      });
    });
  });
}

async function initialize_gcp_project(answers: Partial<any>) {
  // check for gcloud
  const gcloud_res = await exec_cmd('which gcloud', null, {silent: true});
  const gcloud_path = gcloud_res.stdout.trim();
  if (gcloud_res.code !== 0 || !fs.existsSync(gcloud_path)) {
    console.log(
      chalk.red(
        'Could not find gcloud command, please make sure you installed Google Cloud SDK'
      ) +
        ' - see ' +
        chalk.blue('https://cloud.google.com/sdk/docs/install')
    );
    process.exit(-1);
  }
  // now check for authentication in gcloud
  const auth_output = execSync('gcloud auth print-access-token')
    .toString()
    .trim();
  if (auth_output.includes('ERROR: (gcloud.auth.print-access-token)')) {
    console.log(
      chalk.red('Please authenticate in gcloud using ') +
        chalk.white('gcloud auth login')
    );
    process.exit(-1);
  }
  let gcp_project_id = execSync('gcloud config get-value project 2> /dev/null')
    .toString()
    .trim();
  if (gcp_project_id) {
    if (
      (
        await prompt(
          {
            type: 'confirm',
            name: 'use_current_project',
            message: `Detected currect GCP project ${chalk.green(
              gcp_project_id
            )}, do you want to use it (Y) or choose another (N)?:`,
            default: true,
          },
          answers
        )
      ).use_current_project
    ) {
      return gcp_project_id;
    }
  }
  // otherwise let the user to choose a project
  const projects_csv = child_process
    .execSync(
      'gcloud projects list --format="csv(projectId,projectName)" --sort-by=projectId --limit=500'
    )
    .toString();
  const rows = projects_csv.split('\n').map(row => row.split(','));
  rows.splice(0, 1); // remove header row
  let options = rows
    .filter((cols: string[]) => !!cols[0])
    .map(row => {
      return {
        title: row[0] + (row[1] ? ' (' + row[1] + ')' : ''),
        value: row[0],
      };
    });
  const MANUAL_ITEM = '__MANUAL__';
  options = [{title: 'Enter manually', value: MANUAL_ITEM}].concat(options);
  let response = await prompts({
    type: 'autocomplete',
    name: 'project_id',
    message: 'Please choose a GCP project',
    choices: options,
  });
  gcp_project_id = response.project_id;
  if (response.project_id === MANUAL_ITEM) {
    response = await prompts({
      type: 'text',
      name: 'project_id',
      message: 'Please enter a GCP project id',
    });
    // make sure the entered project does exist
    const describe_output = execSync(
      `gcloud projects describe ${response.project_id}`
    ).toString();
    if (describe_output.includes('ERROR:')) {
      console.log(chalk.red('Could not set current project'));
      console.log(describe_output);
      process.exit(-1);
    }
  }
  gcp_project_id = response.project_id;
  if (gcp_project_id) {
    execSync('gcloud config set project ' + gcp_project_id);
  }
  return gcp_project_id;
}

/**
 * Walks throught directory structure and returns a list of full file paths.
 * @param dirpath a directory path
 * @returns a list of full paths of files in the directory (recursively)
 */
function readDir(dirpath: string) {
  let results: string[] = [];
  const entries = fs.readdirSync(dirpath, {withFileTypes: true});
  entries.forEach((entry: fs.Dirent) => {
    const entry_path = path.resolve(dirpath, entry.name);
    if (entry.isDirectory()) {
      /* Recurse into a subdirectory */
      results = results.concat(readDir(entry_path));
    } else {
      /* Is a file */
      results.push(entry_path);
    }
  });
  return results;
}

function getMacroValues(
  folder_path: string,
  answers: Partial<any>,
  prefix: string
) {
  const filelist = readDir(folder_path);
  const macro: Record<string, null> = {};
  for (const file_path of filelist) {
    if (file_path.endsWith('.sql')) {
      let script_content = fs.readFileSync(file_path, 'utf-8');
      // if script_content contains FUNCTIONS block we should cut it off  before searching for macro
      const fn_match = script_content.match(/FUNCTIONS/i);
      if (fn_match?.index) {
        script_content = script_content.substring(0, fn_match.index);
      }
      // notes on the regexp:
      //  "(?<!\$)" - is a lookbehind expression (catch the following exp if it's
      //  not precended with '$'), with that we're capturing {smth} expressions
      //  and not ${smth} expressions
      const re = /(?<!\$)\{(?<macro>[^}]+)\}/gi;
      const matches = [...script_content.matchAll(re)];
      for (const match of matches) {
        if (match.groups) {
          macro[match.groups['macro']] = null;
        }
      }
    }
  }
  const options = Object.keys(macro).map(name => {
    return {type: <PromptType>'text', name: name, message: name};
  });
  if (options.length) {
    if (
      !answers[prefix] ||
      options.filter(i => !(i.name in answers[prefix])).length
    ) {
      console.log(
        `Please enter values for the following macros found in your scripts in '${folder_path}' folder`
      );
      console.log(
        chalk.yellow('Tip: ') +
          chalk.gray(
            'beside constants you can use :YYYYMMDD-N values and expressions (${..})'
          )
      );
    }
    answers[prefix] = answers[prefix] || {};
    return prompt(options, answers[prefix]);
  }
  return {};
}

async function prompt(
  questions: QuestionCollection<Answers>,
  answers: Partial<any>
) {
  const actual_answers = await inquirer.prompt(questions, answers);
  Object.assign(answers, actual_answers);
  return actual_answers;
}

async function init() {
  let answers: Partial<any> = {};
  if (argv.answers) {
    answers = JSON.parse(fs.readFileSync(argv.answers, 'utf-8')) || {};
    console.log(`Using answers from '${argv.answers}' file`);
  }
  const status_log = `Running create-gaarf-wf in ${cwd}`;
  if (is_debug) {
    fs.writeFileSync(LOG_FILE, `[${new Date()}]${status_log}`);
  }
  console.log(chalk.gray(status_log));
  console.log(
    chalk.yellow(figlet.textSync('Gaarf Workflow', {horizontalLayout: 'full'}))
  );
  console.log(
    'Welcome to interactive generator for Gaarf Workflow (Google Ads API Report Fetcher Workflow)'
  );
  console.log(
    'You will be asked a bunch of questions to prepare and initialize your cloud infrastructure'
  );
  console.log(
    'It is best to run this script in a folder that is a parent for your queries'
  );

  const gcp_project_id = await initialize_gcp_project(answers);

  const PATH_ADS_QUERIES = 'ads-queries';
  const PATH_BQ_QUERIES = 'bq-queries';
  const name = (
    await prompt(
      [
        {
          type: 'input',
          name: 'name',
          message:
            'Your project name (spaces/underscores will be converted to "-"):',
          default: path.basename(cwd),
          filter: value => {
            return value.replaceAll(' ', '-').replaceAll('_', '-');
          },
        },
      ],
      answers
    )
  ).name;
  answers.name = name;
  const ads_queries_folder_candidates = fs
    .readdirSync(cwd)
    .find(
      f =>
        path.basename(f).includes('ads') && path.basename(f).includes('queries')
    );
  const bq_queries_folder_candidates = fs
    .readdirSync(cwd)
    .find(
      f =>
        path.basename(f).includes('bq') && path.basename(f).includes('queries')
    );
  const answers1 = await prompt(
    [
      {
        type: 'input',
        name: 'path_to_ads_queries',
        message: 'Relative path to a folder with your Ads queries:',
        default: ads_queries_folder_candidates || PATH_ADS_QUERIES,
      },
      {
        type: 'input',
        name: 'path_to_bq_queries',
        message: 'Relative path to a folder with your BigQuery queries:',
        default: bq_queries_folder_candidates || PATH_BQ_QUERIES,
      },
      {
        type: 'input',
        name: 'gcs_bucket',
        message: 'GCP bucket name for queries:',
        default: gcp_project_id,
        filter: value => {
          return value.startsWith('gs://')
            ? value.substring('gs://'.length)
            : value;
        },
      },
      {
        type: 'input',
        name: 'path_to_googleads_config',
        message: 'Path to your google-ads.yaml:',
        default: 'google-ads.yaml',
      },
      {
        type: 'input',
        name: 'custom_ids_query_path',
        message:
          'Sql file path with a query to filter customer accounts (leave empty if not needed)',
        default: '',
      },
    ],
    answers
  );
  const path_to_ads_queries = answers1.path_to_ads_queries;
  const path_to_ads_queries_abs = path.join(cwd, path_to_ads_queries);
  const path_to_bq_queries = answers1.path_to_bq_queries;
  const path_to_bq_queries_abs = path.join(cwd, path_to_bq_queries);
  let gcs_bucket = answers1.gcs_bucket;
  const path_to_googleads_config = answers1.path_to_googleads_config;
  if (!fs.existsSync(path_to_ads_queries_abs)) {
    fs.mkdirSync(path_to_ads_queries_abs);
    console.log(chalk.grey(`Created '${path_to_ads_queries_abs}' folder`));
  }
  if (!fs.existsSync(path_to_bq_queries_abs)) {
    fs.mkdirSync(path_to_bq_queries_abs);
    console.log(chalk.grey(`Created '${path_to_bq_queries_abs}' folder`));
  }
  const custom_ids_query_path = answers1.custom_ids_query_path;

  gcs_bucket = (gcs_bucket || gcp_project_id).trim();

  // clone gaarf repo
  const gaarf_folder = 'ads-api-fetcher';
  if (!fs.existsSync(gaarf_folder)) {
    await exec_cmd(
      `git clone ${GIT_REPO} --depth 1 ${gaarf_folder}`,
      new clui.Spinner(`Cloning Gaarf repository (${GIT_REPO}), please wait...`)
    );
  } else {
    execSync(`cd ${gaarf_folder} && git pull --ff`);
  }

  // create a bucket
  const res = await exec_cmd(
    `gsutil mb -b on gs://${gcs_bucket}`,
    new clui.Spinner(`Creating a GCS bucket ${gcs_bucket}`),
    {silent: true}
  );
  if (
    !res.stderr.includes(
      `ServiceException: 409 A Cloud Storage bucket named '${gcs_bucket}' already exists`
    )
  ) {
    console.log(chalk.red(`Could not create a bucket ${gcs_bucket}`));
    console.log(res.stderr);
  }

  // Create deploy-scripts.sh
  let deploy_custom_query_snippet = '';
  let custom_query_gcs_path;
  if (custom_ids_query_path) {
    if (!fs.existsSync(custom_ids_query_path)) {
      console.log(
        chalk.red(`Could not find script '${custom_ids_query_path}'`)
      );
    }
    custom_query_gcs_path = `gs://${gcs_bucket}/${name}/get-accounts.sql`;
    deploy_custom_query_snippet = `gsutil -m cp ${custom_ids_query_path} $GCS_BASE_PATH/get-accounts.sql`;
  }
  // Note that we deploy queries to hard-coded paths
  deploy_shell_script(
    'deploy-scripts.sh',
    `# Deploy Ads and BQ scripts from local folders to Goggle Cloud Storage.
set -e
GCS_BUCKET=gs://${gcs_bucket}
GCS_BASE_PATH=$GCS_BUCKET/${name}

gsutil -m cp ${path_to_googleads_config} $GCS_BASE_PATH/google-ads.yaml
${deploy_custom_query_snippet}

gsutil rm -r $GCS_BASE_PATH/${path_to_ads_queries}
gsutil -m cp -R ./${path_to_ads_queries}/* $GCS_BASE_PATH/${PATH_ADS_QUERIES}/

gsutil rm -r $GCS_BASE_PATH/${path_to_bq_queries}
gsutil -m cp -R ./${path_to_bq_queries}/* $GCS_BASE_PATH/${PATH_BQ_QUERIES}/
`
  );

  // Create deploy-wf.sh
  const workflow_name = name + '-wf';
  const function_name = name;
  let cf_memory = (
    await prompt(
      [
        {
          type: 'list',
          message: 'Memory limit for the Cloud Functions',
          name: 'cf_memory',
          default: '512MB',
          choices: [
            '128MB',
            '256MB',
            '512MB',
            '1024MB',
            '2048MB',
            '4096MB',
            '8192MB',
          ],
        },
      ],
      answers
    )
  ).cf_memory;
  // NOTE: Cloud Function Gen2 (in contrast to Gen1) don't support arbitrary memory size, for using >1GB you need to increase CPU
  //       but `gcloud functions` command doesn't support this.
  //       So have to deploy via `gcloud functions` with small memory and then update via `gcloud run` to update CPU and memory.
  const cf_region = 'us-central1';
  let deploy_cf_add = '';
  if (
    cf_memory === '2048MB' ||
    cf_memory === '4096MB' ||
    cf_memory === '8192MB'
  ) {
    deploy_cf_add = `
gcloud run services update ${function_name} --region ${cf_region} --cpu 1 --memory=${cf_memory.replaceAll(
      'MB',
      'Mi'
    )}
`; //--no-cpu-throttling (add or not?)
    cf_memory = '512MB';
  }
  deploy_shell_script(
    'deploy-wf.sh',
    `# Deploy Cloud Functions and Cloud Workflow
set -e
cd ./${gaarf_folder}
git pull --ff
cd ./gcp/functions
./setup.sh --name ${function_name} --memory ${cf_memory} --region ${cf_region}
${deploy_cf_add}
cd ../workflow
./setup.sh --name ${workflow_name} --region ${cf_region}
`
  );

  const has_ads_queries = !!fs.readdirSync(path_to_ads_queries).length;
  const has_bq_queries = !!fs.readdirSync(path_to_bq_queries).length;
  const has_adsconfig = fs.existsSync(path_to_googleads_config);
  const ready_to_deploy_scripts =
    !!gcp_project_id && has_ads_queries && has_bq_queries && has_adsconfig;
  if (!has_ads_queries || !has_bq_queries) {
    console.log(
      chalk.red(
        `Please place your ads/bq scripts into '${path_to_ads_queries}' and '${path_to_ads_queries}' folders accordinally`
      )
    );
  }
  if (!has_adsconfig) {
    console.log(
      chalk.red(
        `Please put your Ads API config into '${path_to_googleads_config}' file`
      )
    );
  }
  const progress = {
    scripts_deployed: false,
    wf_created: false,
    wf_scheduled: false,
  };

  // now we need parameters for running the WF
  let ads_customer_id;
  if (fs.existsSync(path_to_googleads_config)) {
    const yamldoc = <any>(
      yaml.load(fs.readFileSync(path_to_googleads_config, 'utf-8'))
    );
    ads_customer_id = yamldoc['customer_id'] || yamldoc['client_customer_id'];
  }
  const answers2 = await prompt(
    [
      {
        type: 'input',
        name: 'output_dataset',
        message: 'BigQuery dataset for ads queries results:',
        default: name + '_ads',
      },
      {
        type: 'input',
        name: 'customer_id',
        message: 'Ads account id (customer id, without dashes):',
        default: ads_customer_id,
      },
    ],
    answers
  );

  // now we detect macro used in queries and ask for their values
  const macro_ads = await getMacroValues(
    path.join(cwd, path_to_ads_queries),
    answers,
    'ads_macro'
  );
  const macro_bq = await getMacroValues(
    path.join(cwd, path_to_bq_queries),
    answers,
    'bq_macro'
  );

  const output_dataset = answers2.output_dataset;
  const customer_id = answers2.customer_id;
  const wf_data = {
    cloud_function: name,
    gcs_bucket: gcs_bucket,
    ads_queries_path: `${name}/${PATH_ADS_QUERIES}/`,
    bq_queries_path: `${name}/${PATH_BQ_QUERIES}/`,
    dataset: output_dataset,
    cid: customer_id,
    ads_config_path: `gs://${gcs_bucket}/${name}/google-ads.yaml`,
    customer_ids_query: custom_query_gcs_path,
    bq_dataset_location: '', // TODO: should we ask the user about a region? By default 'us' will be used
    ads_macro: macro_ads,
    bq_macro: macro_bq,
    bq_sql: {},
  };

  // Create run-wf.sh
  deploy_shell_script(
    'run-wf.sh',
    `gcloud workflows run ${workflow_name} \
  --data='${JSON.stringify(wf_data, null, 2)}'
`
  );

  const answers3 = await prompt(
    {
      //when: progress.scripts_deployed && progress.wf_created,
      type: 'confirm',
      name: 'schedule_wf',
      message: 'Do you want to schedule a job for executing workflow:',
      default: true,
    },
    answers
  );
  let schedule_cron = '0 0 * * *';
  if (answers3.schedule_wf) {
    const answers_schedule = await prompt(
      [
        {
          type: 'input',
          name: 'schedule_time',
          message: 'Enter time (hh:mm) for job to start:',
          default: '00:00',
          validate: (input: string) =>
            !input.match(/\d+(:\d+)*/gi) ? 'Please use the format 00:00' : true,
        },
        {
          type: 'confirm',
          name: 'run_job',
          message: 'Do you want to run the job right now',
        },
      ],
      answers
    );
    const time_parts = answers_schedule.schedule_time.split(':');
    schedule_cron = `${time_parts.length > 1 ? time_parts[1] : 0} ${
      time_parts[0]
    } * * *`;
    answers3.run_job = answers_schedule.run_job;
  }
  // Create schedule-wf.sh
  deploy_shell_script(
    'schedule-wf.sh',
    `# Create Scheduler Job to execute Cloud Workflow
PROJECT_ID=${gcp_project_id}
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format="csv(projectNumber)" | tail -n 1)
# be default Cloud Worflows run under the Compute Engine default service account:
SERVICE_ACCOUNT=$PROJECT_NUMBER-compute@developer.gserviceaccount.com

REGION=${cf_region}
WORKFLOW_NAME=${workflow_name}
JOB_NAME=$WORKFLOW_NAME

data='${JSON.stringify(wf_data, null, 2).replaceAll('"', '\\"')}'

gcloud scheduler jobs delete $JOB_NAME --location $REGION --quiet

# daily at midnight
gcloud scheduler jobs create http $JOB_NAME \\
  --schedule="${schedule_cron}" \\
  --uri="https://workflowexecutions.googleapis.com/v1/projects/$PROJECT_ID/locations/$REGION/workflows/$WORKFLOW_NAME/executions" \
  --location=$REGION \\
  --message-body="{\\"argument\\": \\"$data\\"}" \\
  --oauth-service-account-email="$SERVICE_ACCOUNT" \\
  --time-zone="Etc/UTC"

#  --time-zone="TIME_ZONE" \
# timezone: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones
`
  );

  // now execute some scripts
  if (ready_to_deploy_scripts) {
    if (
      (
        await prompt(
          {
            type: 'confirm',
            name: 'deploy_scripts',
            message: 'Do you want to deploy scripts (Ads/BQ) to GCS:',
            default: true,
          },
          answers
        )
      ).deploy_scripts
    ) {
      await exec_cmd(path.join(cwd, './deploy-scripts.sh'), null, {
        realtime: true,
      });
      progress.scripts_deployed = true;
    } else {
      console.log(
        chalk.yellow(
          "Please note that before you deploy queries to GCS (deploy-scripts.sh) there's no sense in running workflow (it'll fail)"
        )
      );
    }
  }

  if (
    (
      await prompt(
        {
          type: 'confirm',
          name: 'deploy_wf',
          message: 'Do you want to deploy Cloud components:',
          default: true,
        },
        answers
      )
    ).deploy_wf
  ) {
    await exec_cmd(
      path.join(cwd, './deploy-wf.sh'),
      new clui.Spinner('Deploying Cloud components, please wait...')
    );
    progress.wf_created = true;
  } else {
    console.log(
      chalk.yellow(
        "Please note that before you deploy cloud components (deploy-wf.sh) there's no sense in running a scheduler job"
      )
    );
  }

  if (answers3.schedule_wf) {
    const res = await exec_cmd(
      path.join(cwd, './schedule-wf.sh'),
      new clui.Spinner('Creating a Scheduler Job, please wait...')
    );
    if (res.code === 0) {
      console.log(
        'Created a Scheduler Job. You can recreate it with different settings by running schedule-wf.sh'
      );
    }
    progress.wf_scheduled = true;

    if (answers3.run_job) {
      // running the job
      exec_cmd(
        `gcloud scheduler jobs run ${workflow_name} --location=${cf_region}`,
        null,
        {realtime: true}
      );
    }
  }

  // creating scripts for directly executing gaarf
  const ads_macro_clistr = Object.entries(macro_ads)
    .map(macro => `--macro.${macro[0]}=${macro[1]}`)
    .join(' ');
  deploy_shell_script(
    'run-gaarf-console.sh',
    `${gaarf_folder}/js/gaarf ${path_to_ads_queries}/*.sql --account=${customer_id} --ads-config=${path_to_googleads_config} --output=console --console.transpose=always ${ads_macro_clistr}`
  );
  deploy_shell_script(
    'run-gaarf.sh',
    `${gaarf_folder}/js/gaarf ${path_to_ads_queries}/*.sql --account=${customer_id} --ads-config=${path_to_googleads_config} --output=bq --bq.project=${gcp_project_id} --bq.dataset=${output_dataset} ${ads_macro_clistr}`
  );
  const bq_macro_clistr = Object.entries(macro_bq)
    .map(macro => `--macro.${macro[0]}=${macro[1]}`)
    .join(' ');
  deploy_shell_script(
    'run-gaarf-bq.sh',
    `${gaarf_folder}/js/gaarf-bq ${path_to_bq_queries}/*.sql --project=${gcp_project_id} ${bq_macro_clistr}`
  );

  console.log(chalk.green('All done'));

  console.log(chalk.yellow('Tips for using the generated scripts:'));
  console.log(
    ` 🔹 ${chalk.cyan(
      'deploy-scripts.sh'
    )} - redeploy queries and google-ads.yaml to GCS`
  );
  console.log(
    ` 🔹 ${chalk.cyan('deploy-wf.sh')} - redeploy Cloud Functions and Workflow`
  );
  console.log(
    ` 🔹 ${chalk.cyan(
      'run-wf.sh'
    )} - execute workflow directly, see arguments inside`
  );
  console.log(
    ` 🔹 ${chalk.cyan(
      'schedule-wf.sh'
    )} - reschedule workflow execution, see arguments inside`
  );
  console.log(
    ` 🔹 ${chalk.cyan(
      'run-gaarf-*.sh'
    )} - scripts for direct query execution via gaarf (via command line)`
  );

  const saveAnswers = argv.save || argv.saveAnswers;
  if (saveAnswers) {
    const output_file = saveAnswers === true ? 'answers.json' : saveAnswers;
    fs.writeFileSync(output_file, JSON.stringify(answers, null, 2));
    console.log(chalk.gray(`Answers saved into ${output_file}`));
  }
}

init().catch(e => {
  console.error(e);
});
