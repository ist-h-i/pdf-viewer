# PdfViewer

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 20.2.1.

## Development server

To start a local development server, run:

```bash
ng serve
```

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## PDF 表示メモ

- ローカル PDF はファイルピッカーから読み込み、ng2-pdf-viewer がバンドル済みの `pdfjs-dist/build/pdf.worker.min.mjs` を利用します（追加の CDN 設定は不要）。
- ワーカー取得エラーで表示されない場合はブラウザコンソールのエラーメッセージを確認し、再ビルド後に再読み込みしてください。
- The pdf.js worker is bundled locally at `public/assets/pdf.worker.min.mjs` and is copied into `dist/pdf-viewer/browser/assets/` during build; no CDN configuration is required.

## Running unit tests

To execute unit tests with the [Karma](https://karma-runner.github.io) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
