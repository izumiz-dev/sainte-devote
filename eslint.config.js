module.exports = [
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        // ブラウザ環境のグローバル
        window: 'readonly',
        document: 'readonly',
        // Electronのグローバル
        require: 'readonly',
        process: 'readonly',
        // MonacoEditorのグローバル
        monaco: 'readonly',
        // Node.js環境のグローバル
        __dirname: 'readonly',
        __filename: 'readonly',
        module: 'readonly',
        // ES2024のグローバル
        Promise: 'readonly',
        Map: 'readonly',
        Set: 'readonly',
      },
    },
    rules: {
      // 基本ルール
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-unused-vars': ['warn'],
      quotes: ['error', 'single'],
      semi: ['error', 'always'],
      indent: ['error', 2],

      // ES6+
      'arrow-spacing': 'error',
      'no-var': 'error',
      'prefer-const': 'error',

      // エラー防止
      'no-undef': 'error',
      'no-unused-expressions': 'error',
    },
    ignores: ['node_modules/**', 'dist/**', 'out/**'],
  },
];
