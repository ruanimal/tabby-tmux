import path from 'path'
import * as url from 'url'
import * as fs from 'fs'
import webpack from 'webpack'
import { AngularWebpackPlugin } from '@ngtools/webpack'
import { createEs2015LinkerPlugin } from '@angular/compiler-cli/linker/babel'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))

export default {
  mode: 'development',
  // Disable webpack's filesystem cache (dev-mode default): incremental builds
  // failed to pick up source changes, leaving stale dist output that looked
  // like the fix wasn't applied. Correctness over rebuild speed here.
  cache: false,
  devtool: 'source-map',
  target: 'node',
  entry: {
    index: path.resolve(__dirname, 'src/index.ts'),
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    libraryTarget: 'umd',
    globalObject: 'this',
    publicPath: 'auto',
  },
  resolve: {
    extensions: ['.ts', '.js'],
    modules: [
      path.resolve(__dirname, 'src'),
      'node_modules',
    ],
  },
  externals: [
    /^@angular/,
    /^@ng-bootstrap/,
    /^rxjs/,
    /^tabby-/,
    'tabby-local',
    'child_process',
    'fs',
    'path',
    'os',
    'module',
    'assert',
  ],
  module: {
    rules: [
      {
        test: /\.(m?)js$/,
        loader: 'babel-loader',
        options: {
          plugins: [
            createEs2015LinkerPlugin({
              linkerJitMode: true,
              fileSystem: {
                resolve: path.resolve,
                exists: fs.existsSync,
                dirname: path.dirname,
                relative: path.relative,
                readFile: fs.readFileSync,
              }
            })
          ],
          compact: false,
          cacheDirectory: true,
        },
        resolve: {
          fullySpecified: false,
        },
      },
      {
        test: /\.ts$/,
        loader: '@ngtools/webpack',
      },
      {
        test: /\.scss$/,
        use: [
          'to-string-loader',
          'css-loader',
          'sass-loader'
        ],
      },
      {
        test: /\.css$/,
        use: [
          'to-string-loader',
          'css-loader'
        ],
      },
      {
        test: /\.svg$/,
        use: ['svg-inline-loader'],
      }
    ]
  },
  plugins: [
    new AngularWebpackPlugin({
      tsconfig: path.resolve(__dirname, 'tsconfig.json'),
      jitMode: true,
    }),
  ]
}
