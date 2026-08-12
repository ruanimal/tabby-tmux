module.exports = {
    root: true,
    parser: '@typescript-eslint/parser',
    plugins: ['@typescript-eslint'],
    extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'prettier'],
    env: {
        es2017: true,
        node: true,
    },
    parserOptions: {
        ecmaVersion: 2017,
        sourceType: 'module',
    },
    rules: {
        // Terminal control sequences (e.g. \x1b) are core to this project,
        // so the generic control-character regex rule does not apply.
        'no-control-regex': 'off',
        // `_`-prefixed names signal intentionally-unused destructured values.
        '@typescript-eslint/no-unused-vars': [
            'error',
            { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
        ],
    },
    ignorePatterns: ['dist/', 'typings/', 'node_modules/'],
}
