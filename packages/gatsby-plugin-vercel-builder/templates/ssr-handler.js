import os from 'os';
import etag from 'etag';
import { parse } from 'url';
import { copySync, existsSync } from 'fs-extra';
import { join, dirname, basename } from 'path';

const TMP_DATA_PATH = join(os.tmpdir(), 'data/datastore');
const CUR_DATA_PATH = join(__dirname, '.cache/data/datastore');

if (!existsSync(TMP_DATA_PATH)) {
  // Copies executable `data` files to the writable /tmp directory.
  copySync(CUR_DATA_PATH, TMP_DATA_PATH);
}

async function getGraphQLEngine() {
  const { GraphQLEngine } = await import(
    join(__dirname, '.cache/query-engine/index.js')
  );

  return new GraphQLEngine({ dbPath: TMP_DATA_PATH });
}

async function getPageSSRHelpers() {
  return await import(join(__dirname, '.cache/page-ssr/index.js'));
}

export default async function handler(req, res) {
  let pageName;
  const pathname = parse(req.url).pathname || '/';
  const isPageData = pathname.startsWith('/page-data/');
  if (isPageData) {
    // /page-data/index/page-data.json
    // /page-data/using-ssr/page-data.json
    pageName = basename(dirname(pathname));
    if (pageName === 'index') {
      pageName = '/';
    }
  } else {
    // /using-ssr
    // /using-ssr/
    // /using-ssr/index.html
    pageName = basename(pathname);
    if (pageName === 'index.html') {
      pageName = basename(dirname(pathname));
    }
    if (!pageName) {
      pageName = '/';
    }
  }

  const [graphqlEngine, { getData, renderHTML, renderPageData }] =
    await Promise.all([getGraphQLEngine(), getPageSSRHelpers()]);

  const data = await getData({
    pathName: pageName,
    graphqlEngine,
    req,
  });

  const results = isPageData
    ? await renderPageData({ data })
    : await renderHTML({ data });

  if (data.serverDataHeaders) {
    for (const [name, value] of Object.entries(data.serverDataHeaders)) {
      res.setHeader(name, value);
    }
  }

  if (data.serverDataStatus) {
    res.statusCode = data.serverDataStatus;
  }

  if (isPageData) {
    res.setHeader('ETag', etag(JSON.stringify(results)));
    res.json(results);
  } else {
    res.send(results);
  }
}
