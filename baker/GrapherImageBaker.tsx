import * as lodash from "lodash"
import * as db from "../db/db"
import { getVariableData } from "../db/model/Variable"
import * as fs from "fs-extra"
import svgo from "svgo"
import sharp from "sharp"
import * as path from "path"
import { GrapherInterface } from "../grapher/core/GrapherInterface"
import { Grapher } from "../grapher/core/Grapher"
import {
    grapherSlugToExportFileKey,
    grapherUrlToSlugAndQueryStr,
} from "./GrapherBakingUtils"

export async function bakeGraphersToPngs(
    outDir: string,
    jsonConfig: GrapherInterface,
    vardata: any,
    optimizeSvgs = false
) {
    const grapher = new Grapher({ ...jsonConfig, manuallyProvideData: true })
    grapher.isExportingtoSvgOrPng = true
    grapher.receiveLegacyData(vardata)
    const outPath = path.join(outDir, grapher.slug as string)

    let svgCode = grapher.staticSVG
    if (optimizeSvgs) svgCode = await optimizeSvg(svgCode)

    return Promise.all([
        fs
            .writeFile(`${outPath}.svg`, svgCode)
            .then(() => console.log(`${outPath}.svg`)),
        sharp(Buffer.from(grapher.staticSVG), { density: 144 })
            .png()
            .resize(grapher.idealBounds.width, grapher.idealBounds.height)
            .flatten({ background: "#ffffff" })
            .toFile(`${outPath}.png`),
    ])
}

export async function getGraphersAndRedirectsBySlug() {
    const { graphersBySlug, graphersById } = await getPublishedGraphersBySlug()

    const redirectQuery = db.queryMysql(
        `SELECT slug, chart_id FROM chart_slug_redirects`
    )

    for (const row of await redirectQuery) {
        const grapher = graphersById.get(row.chart_id)
        if (grapher !== undefined) {
            graphersBySlug.set(row.slug, grapher)
        }
    }

    return graphersBySlug
}

export async function getPublishedGraphersBySlug(
    includePrivate: boolean = true
) {
    const graphersBySlug: Map<string, GrapherInterface> = new Map()
    const graphersById: Map<number, GrapherInterface> = new Map()

    const sql = includePrivate
        ? `SELECT * FROM charts WHERE JSON_EXTRACT(config, "$.isPublished") IS TRUE`
        : `SELECT charts.id as id, charts.config as config FROM charts
LEFT JOIN chart_tags on chart_tags.chartId = charts.id
LEFT JOIN tags on tags.id = chart_tags.tagid
WHERE JSON_EXTRACT(config, "$.isPublished") IS TRUE
AND tags.name != 'Private'`

    const query = db.queryMysql(sql)
    for (const row of await query) {
        const grapher = JSON.parse(row.config)

        grapher.id = row.id
        graphersBySlug.set(grapher.slug, grapher)
        graphersById.set(row.id, grapher)
    }
    return { graphersBySlug, graphersById }
}

export async function bakeGrapherToSvg(
    jsonConfig: GrapherInterface,
    outDir: string,
    slug: string,
    queryStr = "",
    optimizeSvgs = false,
    overwriteExisting = false,
    verbose = true
) {
    const grapher = initGrapherForSvgExport(jsonConfig, queryStr)
    const { width, height } = grapher.idealBounds
    const outPath = buildSvgOutFilename(
        slug,
        queryStr,
        outDir,
        jsonConfig.version,
        width,
        height,
        verbose
    )

    if (fs.existsSync(outPath) && !overwriteExisting) return
    const variableIds = grapher.dimensions.map((d) => d.variableId)
    const vardata = await getVariableData(variableIds)
    grapher.receiveLegacyData(vardata)

    let svgCode = grapher.staticSVG
    if (optimizeSvgs) svgCode = await optimizeSvg(svgCode)

    fs.writeFile(outPath, svgCode)
    return svgCode
}

export function initGrapherForSvgExport(
    jsonConfig: GrapherInterface,
    queryStr: string
) {
    const grapher = new Grapher({
        ...jsonConfig,
        manuallyProvideData: true,
        queryStr,
    })
    grapher.isExportingtoSvgOrPng = true
    return grapher
}

export function buildSvgOutFilename(
    slug: string,
    queryStr: string,
    outDir: string,
    version: number | undefined,
    width: number,
    height: number,
    verbose: boolean
) {
    const fileKey = grapherSlugToExportFileKey(slug, queryStr)
    const outPath = `${outDir}/${fileKey}_v${version}_${width}x${height}.svg`
    if (verbose) console.log(outPath)
    return outPath
}

export async function bakeGraphersToSvgs(
    grapherUrls: string[],
    outDir: string,
    optimizeSvgs = false
) {
    await fs.mkdirp(outDir)
    const graphersBySlug = await getGraphersAndRedirectsBySlug()

    return Promise.all(
        Array.from(grapherUrls).map((grapherUrl) => {
            const { slug, queryStr } = grapherUrlToSlugAndQueryStr(grapherUrl)
            const jsonConfig = graphersBySlug.get(slug)
            if (jsonConfig) {
                return bakeGrapherToSvg(
                    jsonConfig,
                    outDir,
                    slug,
                    queryStr,
                    optimizeSvgs
                )
            }
            return undefined
        })
    )
}

const svgoConfig: svgo.Options = {
    floatPrecision: 2,
    plugins: [
        { collapseGroups: false }, // breaks the "Our World in Data" logo in the upper right
        { removeUnknownsAndDefaults: false }, // would remove hrefs from links (<a>)
        { removeViewBox: false },
        { removeXMLNS: false },
    ],
}

const svgoInstance = new svgo(svgoConfig)

async function optimizeSvg(svgString: string): Promise<string> {
    const optimizedSvg = await svgoInstance.optimize(svgString)
    return optimizedSvg.data
}

export async function grapherToSVG(
    jsonConfig: GrapherInterface,
    vardata: any
): Promise<string> {
    const grapher = new Grapher({ ...jsonConfig, manuallyProvideData: true })
    grapher.isExportingtoSvgOrPng = true
    grapher.receiveLegacyData(vardata)
    return grapher.staticSVG
}
