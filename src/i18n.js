import { extendedTranslations } from './i18n-extended.js';
import { securityTranslations } from './i18n-security.js';
import { previewTranslations } from './i18n-preview.js';
import { repositorySettingsTranslations } from './i18n-repository-settings.js';

const LANGUAGE_COOKIE = 'recorddrive.lang';
const LANGUAGE_COOKIE_MAX_AGE = 1000 * 60 * 60 * 24 * 365;

export const DEFAULT_LANGUAGE = 'en';
export const SUPPORTED_LANGUAGES = Object.freeze([
  { code: 'en', name: 'English' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'fr', name: 'Français' },
  { code: 'es', name: 'Español' },
  { code: 'pt', name: 'Português' }
]);

const SUPPORTED_CODES = new Set(SUPPORTED_LANGUAGES.map(({ code }) => code));

const translations = {
  ja: {
    'My Drive': 'マイドライブ',
    'Admin': '管理',
    'Settings': '設定',
    'Primary navigation': 'メインナビゲーション',
    'RecordDrive home': 'RecordDrive ホーム',
    'Administrator': '管理者',
    'User': 'ユーザー',
    'Sign out': 'サインアウト',
    'Secure team file storage': '安全なチームファイルストレージ',
    'Dismiss notification': '通知を閉じる',
    'Show': '表示',
    'Hide': '非表示',
    'Show password': 'パスワードを表示',
    'Hide password': 'パスワードを非表示',
    'Do you want to continue?': '続行しますか？',
    'Sign in': 'サインイン',
    'TEAM CLOUD STORAGE': 'チームクラウドストレージ',
    'Keep every record organized,': 'すべての記録を整理して、',
    'securely together.': '安全に共有。',
    'Organize files in team repositories and give access only to the people who need it.': 'チームリポジトリでファイルを整理し、必要な人だけにアクセスを許可できます。',
    'Role-based access': 'ロールベースアクセス',
    'File uploads': 'ファイルアップロード',
    'Activity history': 'アクティビティ履歴',
    'WELCOME BACK': 'おかえりなさい',
    'Sign in to RecordDrive': 'RecordDrive にサインイン',
    'Use the account provided by your administrator.': '管理者から提供されたアカウントを使用してください。',
    'Username': 'ユーザー名',
    'Enter your username': 'ユーザー名を入力',
    'Password': 'パスワード',
    'Enter your password': 'パスワードを入力',
    'Contact your RecordDrive administrator if you need an account or repository access.': 'アカウントまたはリポジトリアクセスが必要な場合は、RecordDrive 管理者に連絡してください。',
    'The username or password is incorrect.': 'ユーザー名またはパスワードが正しくありません。',
    'Too many sign-in attempts. Try again in about {{minutes}} minute(s).': 'サインイン試行回数が多すぎます。約 {{minutes}} 分後に再試行してください。',
    'MY RECORDDRIVE': 'マイ RECORDDRIVE',
    "{{name}}'s Drive": '{{name}} のドライブ',
    'Administrator access includes every repository and every repository action.': '管理者はすべてのリポジトリと操作にアクセスできます。',
    'Create personal repositories and open only repositories shared with your account.': '個人リポジトリを作成し、自分のアカウントに共有されたリポジトリだけを開けます。',
    'Review all repositories': 'すべてのリポジトリを確認',
    '+ New personal repository': '+ 新しい個人リポジトリ',
    'Visible repositories': '表示可能なリポジトリ',
    'Total files': 'ファイル合計',
    'Storage used': '使用容量',
    'PERSONAL REPOSITORY': '個人リポジトリ',
    'Create a repository': 'リポジトリを作成',
    'You become the owner and receive every permission automatically.': '作成者が所有者となり、すべての権限が自動的に付与されます。',
    'Repository name': 'リポジトリ名',
    'e.g. Project Archive': '例：プロジェクトアーカイブ',
    'Description': '説明',
    'Optional purpose or notes': '任意の目的またはメモ',
    'Create repository': 'リポジトリを作成',
    'Repository list': 'リポジトリ一覧',
    'Owner': '所有者',
    'Shared': '共有',
    'No description has been provided.': '説明はありません。',
    'No description provided.': '説明はありません。',
    'file': 'ファイル',
    'files': 'ファイル',
    'shared user': '共有ユーザー',
    'shared users': '共有ユーザー',
    'user': 'ユーザー',
    'users': 'ユーザー',
    'item': '項目',
    'items': '項目',
    'Upload': 'アップロード',
    'Download': 'ダウンロード',
    'Delete': '削除',
    'Owner: {{name}}': '所有者：{{name}}',
    'Deleted account': '削除済みアカウント',
    'Updated {{date}}': '更新：{{date}}',
    'No files yet': 'まだファイルはありません',
    'No repositories to display': '表示するリポジトリがありません',
    'No user has created a repository yet.': 'まだユーザーがリポジトリを作成していません。',
    'Create your first personal repository, or ask another owner to grant view permission.': '最初の個人リポジトリを作成するか、別の所有者に表示権限を依頼してください。',
    'ADMIN CONSOLE': '管理コンソール',
    'Admin dashboard': '管理ダッシュボード',
    'Manage accounts, user-owned repositories, permission grants, and activity across RecordDrive.': 'RecordDrive 全体のアカウント、ユーザー所有リポジトリ、権限、アクティビティを管理します。',
    'Dashboard': 'ダッシュボード',
    'Repositories': 'リポジトリ',
    'Accounts': 'アカウント',
    'Admin navigation': '管理ナビゲーション',
    'Member accounts': 'メンバーアカウント',
    'Registered regular user accounts': '登録済み一般ユーザーアカウント',
    'User-owned file spaces': 'ユーザー所有のファイル領域',
    'Files': 'ファイル',
    'All uploaded files': 'アップロード済みファイルすべて',
    'Local disk usage': 'ローカルディスク使用量',
    'RECENT ACTIVITY': '最近のアクティビティ',
    'Recent activity': '最近のアクティビティ',
    'Sign in activity': 'サインイン',
    'Account created': 'アカウント作成',
    'Account deleted': 'アカウント削除',
    'Repository created': 'リポジトリ作成',
    'Repository deleted': 'リポジトリ削除',
    'Permission granted': '権限付与',
    'Permission updated': '権限更新',
    'Permission revoked': '権限取消',
    'File uploaded': 'ファイルアップロード',
    'File deleted': 'ファイル削除',
    'HTTPS settings updated': 'HTTPS 設定更新',
    'No activity has been recorded yet.': 'まだアクティビティは記録されていません。',
    'REPOSITORY MANAGEMENT': 'リポジトリ管理',
    'Repository management': 'リポジトリ管理',
    'Repositories are created by regular users. Administrators can inspect, manage permissions, and permanently remove any repository.': 'リポジトリは一般ユーザーが作成します。管理者は確認、権限管理、完全削除ができます。',
    'REPOSITORIES': 'リポジトリ',
    'All user repositories': 'すべてのユーザーリポジトリ',
    'Repository creation is intentionally unavailable to administrators.': '管理者によるリポジトリ作成は無効化されています。',
    'Permissions': '権限',
    'Permanently delete the \'{{name}}\' repository and all of its files? This action cannot be undone.': '「{{name}}」リポジトリとすべてのファイルを完全に削除しますか？この操作は元に戻せません。',
    'No user repositories have been created yet.': 'まだユーザーリポジトリは作成されていません。',
    'ACCOUNT MANAGEMENT': 'アカウント管理',
    'Account management': 'アカウント管理',
    'Create and manage regular user accounts that can own repositories and receive permission grants.': 'リポジトリを所有し、権限を受け取れる一般ユーザーアカウントを作成・管理します。',
    'NEW ACCOUNT': '新規アカウント',
    'Create account': 'アカウントを作成',
    'Display name': '表示名',
    'e.g. Jordan Lee': '例：Jordan Lee',
    'e.g. jordan.lee': '例：jordan.lee',
    'Lowercase letters, numbers, periods, underscores, and hyphens · 3–32 characters': '小文字、数字、ピリオド、アンダースコア、ハイフン · 3～32文字',
    'Initial password': '初期パスワード',
    'Use at least 8 characters and share the password securely with the user.': '8文字以上を使用し、パスワードは安全な方法でユーザーに共有してください。',
    'USERS': 'ユーザー',
    'Registered accounts': '登録済みアカウント',
    'Account': 'アカウント',
    'Role': 'ロール',
    'Uploads': 'アップロード',
    'Created': '作成日',
    'Actions': '操作',
    'Protected': '保護済み',
    'Delete this account? Permission grants will be removed, owned repositories will become unassigned, and uploaded files will remain in place.': 'このアカウントを削除しますか？権限は削除され、所有リポジトリは所有者なしとなり、アップロード済みファイルは残ります。',
    'Use 3-32 lowercase letters, numbers, periods, underscores, or hyphens for the username.': 'ユーザー名には3～32文字の小文字、数字、ピリオド、アンダースコア、ハイフンを使用してください。',
    'The display name must be between 2 and 50 characters.': '表示名は2～50文字にしてください。',
    'The password must be between 8 and 128 characters.': 'パスワードは8～128文字にしてください。',
    'That username is already in use.': 'そのユーザー名はすでに使用されています。',
    'Created the account for {{name}}.': '{{name}} のアカウントを作成しました。',
    'The account to delete could not be found.': '削除するアカウントが見つかりません。',
    'Administrator accounts cannot be deleted.': '管理者アカウントは削除できません。',
    'Deleted the account for {{name}}.': '{{name}} のアカウントを削除しました。',
    'REPOSITORY PERMISSIONS': 'リポジトリ権限',
    '{{name}} access': '{{name}} のアクセス権',
    'Grant each user only the repository actions they need. The owner and administrators always retain every permission.': '各ユーザーには必要な操作だけを付与してください。所有者と管理者は常にすべての権限を保持します。',
    '← Back': '← 戻る',
    'Open repository': 'リポジトリを開く',
    'OWNER': '所有者',
    'Ownership is currently unassigned.': '現在、所有者は設定されていません。',
    'View': '表示',
    'Open the repository and see file metadata.': 'リポジトリを開き、ファイル情報を表示します。',
    'Add files through the upload endpoint.': 'アップロード機能でファイルを追加します。',
    'Download stored file contents.': '保存されたファイル内容をダウンロードします。',
    'Delete files and permanently delete the repository.': 'ファイルとリポジトリを完全に削除します。',
    'NEW GRANT': '新しい権限',
    'Share with a user': 'ユーザーと共有',
    'User account': 'ユーザーアカウント',
    'Select a user': 'ユーザーを選択',
    'Allowed actions': '許可する操作',
    'Open and browse': '開いて閲覧',
    'Add new files': '新しいファイルを追加',
    'Retrieve file data': 'ファイルデータを取得',
    'Files and repository': 'ファイルとリポジトリ',
    'Save permission grant': '権限を保存',
    'Every eligible user already has a permission grant.': '対象ユーザー全員にすでに権限が付与されています。',
    'Update or revoke an existing grant below.': '下の既存権限を更新または取り消してください。',
    'CURRENT GRANTS': '現在の権限',
    'Shared users': '共有ユーザー',
    'Updated': '更新',
    'Update': '更新',
    'Revoke': '取り消す',
    'Revoke every permission for {{name}}?': '{{name}} のすべての権限を取り消しますか？',
    'This repository has not been shared with another user.': 'このリポジトリは他のユーザーと共有されていません。',
    'The repository name must be between 2 and 60 characters.': 'リポジトリ名は2～60文字にしてください。',
    'The description must be 300 characters or fewer.': '説明は300文字以内にしてください。',
    'A repository with that name already exists.': '同じ名前のリポジトリがすでに存在します。',
    'Created your {{name}} repository.': '{{name}} リポジトリを作成しました。',
    'The selected user account could not be granted access.': '選択したユーザーにアクセス権を付与できませんでした。',
    'Select at least one permission.': '少なくとも1つの権限を選択してください。',
    'Saved repository permissions for {{name}}.': '{{name}} のリポジトリ権限を保存しました。',
    'The selected user account could not be found.': '選択したユーザーアカウントが見つかりません。',
    'Select at least one permission or revoke access.': '少なくとも1つの権限を選択するか、アクセスを取り消してください。',
    'Updated repository permissions for {{name}}.': '{{name}} のリポジトリ権限を更新しました。',
    "Revoked {{name}}'s repository permissions.": '{{name}} のリポジトリ権限を取り消しました。',
    'No permission grant was found for that account.': 'そのアカウントの権限が見つかりません。',
    'Administrator access': '管理者アクセス',
    'Owner access': '所有者アクセス',
    'Shared access': '共有アクセス',
    'Manage the files in this repository securely.': 'このリポジトリのファイルを安全に管理します。',
    '{{count}} file': '{{count}} ファイル',
    '{{count}} files': '{{count}} ファイル',
    '{{size}} used': '{{size}} 使用',
    '{{count}} shared user': '{{count}} 共有ユーザー',
    '{{count}} shared users': '{{count}} 共有ユーザー',
    'Repository summary': 'リポジトリ概要',
    'Manage permissions': '権限を管理',
    'Permanently delete this repository and every stored file? This action cannot be undone.': 'このリポジトリと保存されたすべてのファイルを完全に削除しますか？この操作は元に戻せません。',
    'Delete repository': 'リポジトリを削除',
    'Navigation controls': 'ナビゲーション操作',
    'Back': '戻る',
    'Refresh': '更新',
    'Current location': '現在の場所',
    'Search in {{name}}': '{{name}} 内を検索',
    'Search repository files': 'リポジトリファイルを検索',
    'Clear search': '検索をクリア',
    'Upload files': 'ファイルをアップロード',
    'Permanently delete the selected file?': '選択したファイルを完全に削除しますか？',
    'View-only access': '表示専用アクセス',
    'No item selected': '項目が選択されていません',
    'Sort by': '並べ替え',
    'Sort files': 'ファイルを並べ替え',
    'Newest first': '新しい順',
    'Oldest first': '古い順',
    'Name A–Z': '名前 A–Z',
    'Name Z–A': '名前 Z–A',
    'Largest first': 'サイズの大きい順',
    'Smallest first': 'サイズの小さい順',
    'File view': 'ファイル表示',
    'List view': 'リスト表示',
    'Icon view': 'アイコン表示',
    'File upload': 'ファイルアップロード',
    'UPLOAD': 'アップロード',
    'Add files to this repository': 'このリポジトリにファイルを追加',
    'Drag files here or choose them from your device.': 'ここにファイルをドラッグするか、デバイスから選択してください。',
    'Close upload panel': 'アップロードパネルを閉じる',
    'Drop files here': 'ここにファイルをドロップ',
    'Up to {{size}} MB per file · Up to {{count}} files at a time': '1ファイル最大 {{size}} MB · 一度に最大 {{count}} ファイル',
    'Choose from device': 'デバイスから選択',
    'Upload selected files': '選択したファイルをアップロード',
    'This repository': 'このリポジトリ',
    'All files': 'すべてのファイル',
    'Images': '画像',
    'Documents': 'ドキュメント',
    'Media': 'メディア',
    'Archives': 'アーカイブ',
    'Other': 'その他',
    '{{count}} file is stored in this repository.': 'このリポジトリには {{count}} ファイルが保存されています。',
    '{{count}} files are stored in this repository.': 'このリポジトリには {{count}} ファイルが保存されています。',
    'File categories': 'ファイルカテゴリ',
    'File list': 'ファイル一覧',
    'Search results for “{{search}}”': '「{{search}}」の検索結果',
    'Search:': '検索：',
    'Name': '名前',
    'Uploaded': 'アップロード日',
    'Type': '種類',
    'Size': 'サイズ',
    'Uploader': 'アップロード者',
    'Image': '画像',
    'Video': '動画',
    'Audio': '音声',
    'Archive': 'アーカイブ',
    'Spreadsheet': 'スプレッドシート',
    'Presentation': 'プレゼンテーション',
    'PDF document': 'PDF ドキュメント',
    'Document': 'ドキュメント',
    'File': 'ファイル',
    'Select': '選択',
    'Select {{name}}': '{{name}} を選択',
    'Click once to select; double-click to download': '1回クリックで選択、ダブルクリックでダウンロード',
    'Click to select': 'クリックして選択',
    'Download {{name}}': '{{name}} をダウンロード',
    'More options': 'その他のオプション',
    'More actions for {{name}}': '{{name}} のその他の操作',
    "Permanently delete '{{name}}'?": '「{{name}}」を完全に削除しますか？',
    'No files match this category': 'このカテゴリに一致するファイルはありません',
    'Choose another file type or upload a new file.': '別のファイル種類を選ぶか、新しいファイルをアップロードしてください。',
    'No search results': '検索結果はありません',
    'This repository is empty': 'このリポジトリは空です',
    'Try another name or return to all files.': '別の名前で検索するか、すべてのファイルに戻ってください。',
    'Upload the first file to share it with the team.': '最初のファイルをアップロードしてチームと共有しましょう。',
    'View all files': 'すべてのファイルを表示',
    'File details': 'ファイル詳細',
    'Select a file': 'ファイルを選択',
    'File type, size, uploader, and available actions will appear here.': 'ファイル種類、サイズ、アップロード者、利用可能な操作がここに表示されます。',
    'Details': '詳細',
    'Clear selection': '選択を解除',
    'File type': 'ファイル種類',
    'Delete file': 'ファイルを削除',
    'Uploading…': 'アップロード中…',
    '1 selected · {{name}}': '1件選択 · {{name}}',
    'Select at least one file to upload.': 'アップロードするファイルを少なくとも1つ選択してください。',
    '{{count}} file(s) uploaded successfully.': '{{count}} 件のファイルをアップロードしました。',
    'File not found': 'ファイルが見つかりません',
    'The requested file does not exist.': '要求されたファイルは存在しません。',
    'File data missing': 'ファイルデータがありません',
    'The file record exists, but its data could not be found on disk.': 'ファイル情報はありますが、ディスク上にデータが見つかりません。',
    'The file to delete could not be found.': '削除するファイルが見つかりません。',
    '{{name}} was deleted.': '{{name}} を削除しました。',
    'Deleted the {{name}} repository and its files.': '{{name}} リポジトリとそのファイルを削除しました。',
    'LANGUAGE AND REGION': '言語と地域',
    'Language settings': '言語設定',
    'Choose the language used across RecordDrive. The default follows your browser language.': 'RecordDrive 全体で使用する言語を選択します。既定ではブラウザの言語に従います。',
    'Language preference': '言語設定',
    'Use browser language': 'ブラウザの言語を使用',
    'Browser language': 'ブラウザの言語',
    'Saved preference': '保存済み設定',
    'Current source': '現在の参照元',
    'Save language': '言語を保存',
    'Your selection is stored in this browser and remains available after signing out.': '選択内容はこのブラウザに保存され、サインアウト後も維持されます。',
    'Language preference updated.': '言語設定を更新しました。',
    'The selected language is not supported.': '選択した言語はサポートされていません。',
    'Page not found': 'ページが見つかりません',
    'The requested page does not exist or has been moved.': '要求されたページは存在しないか、移動されました。',
    'Upload failed': 'アップロードに失敗しました',
    'An error occurred while uploading the file.': 'ファイルのアップロード中にエラーが発生しました。',
    'Each file can be up to {{size}} MB.': '各ファイルは最大 {{size}} MB までです。',
    'You can upload up to {{count}} files at a time.': '一度に最大 {{count}} ファイルをアップロードできます。',
    'Server error': 'サーバーエラー',
    'An error occurred while processing the request.': 'リクエストの処理中にエラーが発生しました。',
    'Access denied': 'アクセス拒否',
    'Only administrators can access this page.': 'このページには管理者のみアクセスできます。',
    'Only regular users can create personal repositories.': '個人リポジトリを作成できるのは一般ユーザーのみです。',
    'Request could not be verified': 'リクエストを確認できませんでした',
    'The security token is invalid or has expired. Refresh the page and try again.': 'セキュリティトークンが無効または期限切れです。ページを更新して再試行してください。',
    'RECORDDRIVE ERROR': 'RECORDDRIVE エラー',
    'Go to My Drive': 'マイドライブへ',
    'Go to sign in': 'サインインへ'
  },
  ko: {
    'My Drive': '내 드라이브', 'Admin': '관리', 'Settings': '설정', 'Primary navigation': '기본 탐색', 'RecordDrive home': 'RecordDrive 홈', 'Administrator': '관리자', 'User': '사용자', 'Sign out': '로그아웃', 'Secure team file storage': '안전한 팀 파일 저장소', 'Dismiss notification': '알림 닫기',
    'Show': '표시', 'Hide': '숨기기', 'Show password': '비밀번호 표시', 'Hide password': '비밀번호 숨기기', 'Do you want to continue?': '계속하시겠습니까?',
    'Sign in': '로그인', 'TEAM CLOUD STORAGE': '팀 클라우드 저장소', 'Keep every record organized,': '모든 기록을 체계적으로,', 'securely together.': '안전하게 함께.', 'Organize files in team repositories and give access only to the people who need it.': '팀 저장소에서 파일을 정리하고 필요한 사람에게만 접근 권한을 부여하세요.', 'Role-based access': '역할 기반 접근', 'File uploads': '파일 업로드', 'Activity history': '활동 기록', 'WELCOME BACK': '다시 오신 것을 환영합니다', 'Sign in to RecordDrive': 'RecordDrive 로그인', 'Use the account provided by your administrator.': '관리자가 제공한 계정을 사용하세요.', 'Username': '사용자 이름', 'Enter your username': '사용자 이름 입력', 'Password': '비밀번호', 'Enter your password': '비밀번호 입력', 'Contact your RecordDrive administrator if you need an account or repository access.': '계정이나 저장소 접근 권한이 필요하면 RecordDrive 관리자에게 문의하세요.', 'The username or password is incorrect.': '사용자 이름 또는 비밀번호가 올바르지 않습니다.', 'Too many sign-in attempts. Try again in about {{minutes}} minute(s).': '로그인 시도가 너무 많습니다. 약 {{minutes}}분 후 다시 시도하세요.',
    'MY RECORDDRIVE': '내 RECORDDRIVE', "{{name}}'s Drive": '{{name}}님의 드라이브', 'Administrator access includes every repository and every repository action.': '관리자 권한에는 모든 저장소와 모든 저장소 작업이 포함됩니다.', 'Create personal repositories and open only repositories shared with your account.': '개인 저장소를 만들고 내 계정에 공유된 저장소만 열 수 있습니다.', 'Review all repositories': '모든 저장소 보기', '+ New personal repository': '+ 새 개인 저장소', 'Visible repositories': '표시 가능한 저장소', 'Total files': '전체 파일', 'Storage used': '사용한 저장 공간', 'PERSONAL REPOSITORY': '개인 저장소', 'Create a repository': '저장소 만들기', 'You become the owner and receive every permission automatically.': '만든 사용자가 소유자가 되며 모든 권한을 자동으로 받습니다.', 'Repository name': '저장소 이름', 'e.g. Project Archive': '예: 프로젝트 아카이브', 'Description': '설명', 'Optional purpose or notes': '선택 사항인 용도 또는 메모', 'Create repository': '저장소 만들기', 'Repository list': '저장소 목록', 'Owner': '소유자', 'Shared': '공유됨', 'No description has been provided.': '설명이 없습니다.', 'No description provided.': '설명이 없습니다.',
    'file': '파일', 'files': '파일', 'shared user': '공유 사용자', 'shared users': '공유 사용자', 'user': '사용자', 'users': '사용자', 'item': '항목', 'items': '항목', 'Upload': '업로드', 'Download': '다운로드', 'Delete': '삭제', 'Owner: {{name}}': '소유자: {{name}}', 'Deleted account': '삭제된 계정', 'Updated {{date}}': '{{date}} 업데이트', 'No files yet': '아직 파일 없음', 'No repositories to display': '표시할 저장소가 없습니다', 'No user has created a repository yet.': '아직 사용자가 저장소를 만들지 않았습니다.', 'Create your first personal repository, or ask another owner to grant view permission.': '첫 개인 저장소를 만들거나 다른 소유자에게 보기 권한을 요청하세요.',
    'ADMIN CONSOLE': '관리 콘솔', 'Admin dashboard': '관리 대시보드', 'Manage accounts, user-owned repositories, permission grants, and activity across RecordDrive.': 'RecordDrive의 계정, 사용자 소유 저장소, 권한 부여 및 활동을 관리합니다.', 'Dashboard': '대시보드', 'Repositories': '저장소', 'Accounts': '계정', 'Admin navigation': '관리 탐색', 'Member accounts': '회원 계정', 'Registered regular user accounts': '등록된 일반 사용자 계정', 'User-owned file spaces': '사용자 소유 파일 공간', 'Files': '파일', 'All uploaded files': '업로드된 모든 파일', 'Local disk usage': '로컬 디스크 사용량', 'RECENT ACTIVITY': '최근 활동', 'Recent activity': '최근 활동', 'Sign in activity': '로그인', 'Account created': '계정 생성', 'Account deleted': '계정 삭제', 'Repository created': '저장소 생성', 'Repository deleted': '저장소 삭제', 'Permission granted': '권한 부여', 'Permission updated': '권한 업데이트', 'Permission revoked': '권한 회수', 'File uploaded': '파일 업로드', 'File deleted': '파일 삭제', 'HTTPS settings updated': 'HTTPS 설정 업데이트', 'No activity has been recorded yet.': '아직 기록된 활동이 없습니다.',
    'REPOSITORY MANAGEMENT': '저장소 관리', 'Repository management': '저장소 관리', 'Repositories are created by regular users. Administrators can inspect, manage permissions, and permanently remove any repository.': '저장소는 일반 사용자가 만듭니다. 관리자는 모든 저장소를 확인하고 권한을 관리하며 영구 삭제할 수 있습니다.', 'REPOSITORIES': '저장소', 'All user repositories': '모든 사용자 저장소', 'Repository creation is intentionally unavailable to administrators.': '관리자는 저장소를 직접 만들 수 없도록 설정되어 있습니다.', 'Permissions': '권한', 'Permanently delete the \'{{name}}\' repository and all of its files? This action cannot be undone.': '‘{{name}}’ 저장소와 모든 파일을 영구 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.', 'No user repositories have been created yet.': '아직 사용자 저장소가 생성되지 않았습니다.',
    'ACCOUNT MANAGEMENT': '계정 관리', 'Account management': '계정 관리', 'Create and manage regular user accounts that can own repositories and receive permission grants.': '저장소를 소유하고 권한을 받을 수 있는 일반 사용자 계정을 만들고 관리합니다.', 'NEW ACCOUNT': '새 계정', 'Create account': '계정 만들기', 'Display name': '표시 이름', 'e.g. Jordan Lee': '예: 홍길동', 'e.g. jordan.lee': '예: gildong.hong', 'Lowercase letters, numbers, periods, underscores, and hyphens · 3–32 characters': '영문 소문자, 숫자, 마침표, 밑줄, 하이픈 · 3~32자', 'Initial password': '초기 비밀번호', 'Use at least 8 characters and share the password securely with the user.': '8자 이상을 사용하고 비밀번호는 사용자에게 안전하게 전달하세요.', 'USERS': '사용자', 'Registered accounts': '등록된 계정', 'Account': '계정', 'Role': '역할', 'Uploads': '업로드', 'Created': '생성일', 'Actions': '작업', 'Protected': '보호됨', 'Delete this account? Permission grants will be removed, owned repositories will become unassigned, and uploaded files will remain in place.': '이 계정을 삭제하시겠습니까? 권한 부여는 제거되고 소유 저장소는 미지정 상태가 되며 업로드된 파일은 유지됩니다.', 'Use 3-32 lowercase letters, numbers, periods, underscores, or hyphens for the username.': '사용자 이름은 3~32자의 영문 소문자, 숫자, 마침표, 밑줄 또는 하이픈을 사용하세요.', 'The display name must be between 2 and 50 characters.': '표시 이름은 2~50자여야 합니다.', 'The password must be between 8 and 128 characters.': '비밀번호는 8~128자여야 합니다.', 'That username is already in use.': '이미 사용 중인 사용자 이름입니다.', 'Created the account for {{name}}.': '{{name}} 계정을 만들었습니다.', 'The account to delete could not be found.': '삭제할 계정을 찾을 수 없습니다.', 'Administrator accounts cannot be deleted.': '관리자 계정은 삭제할 수 없습니다.', 'Deleted the account for {{name}}.': '{{name}} 계정을 삭제했습니다.',
    'REPOSITORY PERMISSIONS': '저장소 권한', '{{name}} access': '{{name}} 접근 권한', 'Grant each user only the repository actions they need. The owner and administrators always retain every permission.': '각 사용자에게 필요한 저장소 작업만 부여하세요. 소유자와 관리자는 항상 모든 권한을 유지합니다.', '← Back': '← 뒤로', 'Open repository': '저장소 열기', 'OWNER': '소유자', 'Ownership is currently unassigned.': '현재 소유자가 지정되지 않았습니다.', 'View': '보기', 'Open the repository and see file metadata.': '저장소를 열고 파일 정보를 봅니다.', 'Add files through the upload endpoint.': '업로드 기능으로 파일을 추가합니다.', 'Download stored file contents.': '저장된 파일 내용을 다운로드합니다.', 'Delete files and permanently delete the repository.': '파일과 저장소를 영구 삭제합니다.', 'NEW GRANT': '새 권한', 'Share with a user': '사용자와 공유', 'User account': '사용자 계정', 'Select a user': '사용자 선택', 'Allowed actions': '허용 작업', 'Open and browse': '열기 및 탐색', 'Add new files': '새 파일 추가', 'Retrieve file data': '파일 데이터 받기', 'Files and repository': '파일 및 저장소', 'Save permission grant': '권한 저장', 'Every eligible user already has a permission grant.': '대상 사용자 모두에게 이미 권한이 부여되어 있습니다.', 'Update or revoke an existing grant below.': '아래에서 기존 권한을 업데이트하거나 회수하세요.', 'CURRENT GRANTS': '현재 권한', 'Shared users': '공유 사용자', 'Updated': '업데이트', 'Update': '업데이트', 'Revoke': '회수', 'Revoke every permission for {{name}}?': '{{name}}의 모든 권한을 회수하시겠습니까?', 'This repository has not been shared with another user.': '이 저장소는 다른 사용자와 공유되지 않았습니다.',
    'The repository name must be between 2 and 60 characters.': '저장소 이름은 2~60자여야 합니다.', 'The description must be 300 characters or fewer.': '설명은 300자 이하여야 합니다.', 'A repository with that name already exists.': '같은 이름의 저장소가 이미 있습니다.', 'Created your {{name}} repository.': '{{name}} 저장소를 만들었습니다.', 'The selected user account could not be granted access.': '선택한 사용자 계정에 접근 권한을 부여할 수 없습니다.', 'Select at least one permission.': '권한을 하나 이상 선택하세요.', 'Saved repository permissions for {{name}}.': '{{name}}의 저장소 권한을 저장했습니다.', 'The selected user account could not be found.': '선택한 사용자 계정을 찾을 수 없습니다.', 'Select at least one permission or revoke access.': '권한을 하나 이상 선택하거나 접근 권한을 회수하세요.', 'Updated repository permissions for {{name}}.': '{{name}}의 저장소 권한을 업데이트했습니다.', "Revoked {{name}}'s repository permissions.": '{{name}}의 저장소 권한을 회수했습니다.', 'No permission grant was found for that account.': '해당 계정의 권한 부여를 찾을 수 없습니다.',
    'Administrator access': '관리자 접근', 'Owner access': '소유자 접근', 'Shared access': '공유 접근', 'Manage the files in this repository securely.': '이 저장소의 파일을 안전하게 관리합니다.', '{{count}} file': '{{count}}개 파일', '{{count}} files': '{{count}}개 파일', '{{size}} used': '{{size}} 사용', '{{count}} shared user': '공유 사용자 {{count}}명', '{{count}} shared users': '공유 사용자 {{count}}명', 'Repository summary': '저장소 요약', 'Manage permissions': '권한 관리', 'Permanently delete this repository and every stored file? This action cannot be undone.': '이 저장소와 저장된 모든 파일을 영구 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.', 'Delete repository': '저장소 삭제', 'Navigation controls': '탐색 컨트롤', 'Back': '뒤로', 'Refresh': '새로고침', 'Current location': '현재 위치', 'Search in {{name}}': '{{name}}에서 검색', 'Search repository files': '저장소 파일 검색', 'Clear search': '검색 지우기', 'Upload files': '파일 업로드', 'Permanently delete the selected file?': '선택한 파일을 영구 삭제하시겠습니까?', 'View-only access': '보기 전용 접근', 'No item selected': '선택된 항목 없음', 'Sort by': '정렬 기준', 'Sort files': '파일 정렬', 'Newest first': '최신순', 'Oldest first': '오래된순', 'Name A–Z': '이름 A–Z', 'Name Z–A': '이름 Z–A', 'Largest first': '큰 파일순', 'Smallest first': '작은 파일순', 'File view': '파일 보기', 'List view': '목록 보기', 'Icon view': '아이콘 보기',
    'File upload': '파일 업로드', 'UPLOAD': '업로드', 'Add files to this repository': '이 저장소에 파일 추가', 'Drag files here or choose them from your device.': '여기에 파일을 끌어오거나 기기에서 선택하세요.', 'Close upload panel': '업로드 패널 닫기', 'Drop files here': '여기에 파일 놓기', 'Up to {{size}} MB per file · Up to {{count}} files at a time': '파일당 최대 {{size}}MB · 한 번에 최대 {{count}}개', 'Choose from device': '기기에서 선택', 'Upload selected files': '선택한 파일 업로드', 'This repository': '이 저장소', 'All files': '모든 파일', 'Images': '이미지', 'Documents': '문서', 'Media': '미디어', 'Archives': '압축 파일', 'Other': '기타', '{{count}} file is stored in this repository.': '이 저장소에 파일 {{count}}개가 저장되어 있습니다.', '{{count}} files are stored in this repository.': '이 저장소에 파일 {{count}}개가 저장되어 있습니다.', 'File categories': '파일 범주', 'File list': '파일 목록', 'Search results for “{{search}}”': '“{{search}}” 검색 결과', 'Search:': '검색:', 'Name': '이름', 'Uploaded': '업로드일', 'Type': '유형', 'Size': '크기', 'Uploader': '업로더', 'Image': '이미지', 'Video': '동영상', 'Audio': '오디오', 'Archive': '압축 파일', 'Spreadsheet': '스프레드시트', 'Presentation': '프레젠테이션', 'PDF document': 'PDF 문서', 'Document': '문서', 'File': '파일', 'Select': '선택', 'Select {{name}}': '{{name}} 선택', 'Click once to select; double-click to download': '한 번 클릭해 선택하고 두 번 클릭해 다운로드', 'Click to select': '클릭하여 선택', 'Download {{name}}': '{{name}} 다운로드', 'More options': '추가 옵션', 'More actions for {{name}}': '{{name}} 추가 작업', "Permanently delete '{{name}}'?": '‘{{name}}’을(를) 영구 삭제하시겠습니까?', 'No files match this category': '이 범주와 일치하는 파일이 없습니다', 'Choose another file type or upload a new file.': '다른 파일 유형을 선택하거나 새 파일을 업로드하세요.', 'No search results': '검색 결과 없음', 'This repository is empty': '이 저장소는 비어 있습니다', 'Try another name or return to all files.': '다른 이름으로 검색하거나 모든 파일로 돌아가세요.', 'Upload the first file to share it with the team.': '첫 파일을 업로드해 팀과 공유하세요.', 'View all files': '모든 파일 보기', 'File details': '파일 세부 정보', 'Select a file': '파일 선택', 'File type, size, uploader, and available actions will appear here.': '파일 유형, 크기, 업로더 및 사용 가능한 작업이 여기에 표시됩니다.', 'Details': '세부 정보', 'Clear selection': '선택 해제', 'File type': '파일 유형', 'Delete file': '파일 삭제', 'Uploading…': '업로드 중…', '1 selected · {{name}}': '1개 선택 · {{name}}',
    'Select at least one file to upload.': '업로드할 파일을 하나 이상 선택하세요.', '{{count}} file(s) uploaded successfully.': '파일 {{count}}개를 업로드했습니다.', 'File not found': '파일을 찾을 수 없음', 'The requested file does not exist.': '요청한 파일이 없습니다.', 'File data missing': '파일 데이터 없음', 'The file record exists, but its data could not be found on disk.': '파일 레코드는 있지만 디스크에서 데이터를 찾을 수 없습니다.', 'The file to delete could not be found.': '삭제할 파일을 찾을 수 없습니다.', '{{name}} was deleted.': '{{name}}을(를) 삭제했습니다.', 'Deleted the {{name}} repository and its files.': '{{name}} 저장소와 파일을 삭제했습니다.',
    'LANGUAGE AND REGION': '언어 및 지역', 'Language settings': '언어 설정', 'Choose the language used across RecordDrive. The default follows your browser language.': 'RecordDrive 전체에서 사용할 언어를 선택하세요. 기본값은 브라우저 언어를 따릅니다.', 'Language preference': '언어 기본 설정', 'Use browser language': '브라우저 언어 사용', 'Browser language': '브라우저 언어', 'Saved preference': '저장된 설정', 'Current source': '현재 기준', 'Save language': '언어 저장', 'Your selection is stored in this browser and remains available after signing out.': '선택한 언어는 이 브라우저에 저장되며 로그아웃 후에도 유지됩니다.', 'Language preference updated.': '언어 설정을 업데이트했습니다.', 'The selected language is not supported.': '선택한 언어는 지원되지 않습니다.',
    'Page not found': '페이지를 찾을 수 없음', 'The requested page does not exist or has been moved.': '요청한 페이지가 없거나 이동되었습니다.', 'Upload failed': '업로드 실패', 'An error occurred while uploading the file.': '파일 업로드 중 오류가 발생했습니다.', 'Each file can be up to {{size}} MB.': '각 파일은 최대 {{size}}MB까지 업로드할 수 있습니다.', 'You can upload up to {{count}} files at a time.': '한 번에 최대 {{count}}개 파일을 업로드할 수 있습니다.', 'Server error': '서버 오류', 'An error occurred while processing the request.': '요청 처리 중 오류가 발생했습니다.', 'Access denied': '접근 거부', 'Only administrators can access this page.': '이 페이지는 관리자만 접근할 수 있습니다.', 'Only regular users can create personal repositories.': '개인 저장소는 일반 사용자만 만들 수 있습니다.', 'Request could not be verified': '요청을 확인할 수 없음', 'The security token is invalid or has expired. Refresh the page and try again.': '보안 토큰이 올바르지 않거나 만료되었습니다. 페이지를 새로고침한 뒤 다시 시도하세요.', 'RECORDDRIVE ERROR': 'RECORDDRIVE 오류', 'Go to My Drive': '내 드라이브로 이동', 'Go to sign in': '로그인으로 이동'
  },
  fr: {
    'My Drive': 'Mon Drive', 'Admin': 'Administration', 'Settings': 'Paramètres', 'Primary navigation': 'Navigation principale', 'RecordDrive home': 'Accueil RecordDrive', 'Administrator': 'Administrateur', 'User': 'Utilisateur', 'Sign out': 'Se déconnecter', 'Secure team file storage': 'Stockage de fichiers sécurisé pour les équipes', 'Dismiss notification': 'Fermer la notification',
    'Show': 'Afficher', 'Hide': 'Masquer', 'Show password': 'Afficher le mot de passe', 'Hide password': 'Masquer le mot de passe', 'Do you want to continue?': 'Voulez-vous continuer ?',
    'Sign in': 'Se connecter', 'TEAM CLOUD STORAGE': 'STOCKAGE CLOUD D’ÉQUIPE', 'Keep every record organized,': 'Gardez chaque fichier organisé,', 'securely together.': 'ensemble et en sécurité.', 'Organize files in team repositories and give access only to the people who need it.': 'Organisez les fichiers dans des dépôts d’équipe et donnez accès uniquement aux personnes concernées.', 'Role-based access': 'Accès par rôle', 'File uploads': 'Téléversement de fichiers', 'Activity history': 'Historique d’activité', 'WELCOME BACK': 'BON RETOUR', 'Sign in to RecordDrive': 'Se connecter à RecordDrive', 'Use the account provided by your administrator.': 'Utilisez le compte fourni par votre administrateur.', 'Username': 'Nom d’utilisateur', 'Enter your username': 'Saisissez votre nom d’utilisateur', 'Password': 'Mot de passe', 'Enter your password': 'Saisissez votre mot de passe', 'Contact your RecordDrive administrator if you need an account or repository access.': 'Contactez votre administrateur RecordDrive si vous avez besoin d’un compte ou d’un accès à un dépôt.', 'The username or password is incorrect.': 'Le nom d’utilisateur ou le mot de passe est incorrect.', 'Too many sign-in attempts. Try again in about {{minutes}} minute(s).': 'Trop de tentatives de connexion. Réessayez dans environ {{minutes}} minute(s).',
    'MY RECORDDRIVE': 'MON RECORDDRIVE', "{{name}}'s Drive": 'Drive de {{name}}', 'Administrator access includes every repository and every repository action.': 'L’accès administrateur comprend tous les dépôts et toutes les actions.', 'Create personal repositories and open only repositories shared with your account.': 'Créez des dépôts personnels et ouvrez uniquement ceux partagés avec votre compte.', 'Review all repositories': 'Voir tous les dépôts', '+ New personal repository': '+ Nouveau dépôt personnel', 'Visible repositories': 'Dépôts visibles', 'Total files': 'Total des fichiers', 'Storage used': 'Stockage utilisé', 'PERSONAL REPOSITORY': 'DÉPÔT PERSONNEL', 'Create a repository': 'Créer un dépôt', 'You become the owner and receive every permission automatically.': 'Vous devenez propriétaire et recevez automatiquement toutes les autorisations.', 'Repository name': 'Nom du dépôt', 'e.g. Project Archive': 'ex. Archives du projet', 'Description': 'Description', 'Optional purpose or notes': 'Objectif ou notes facultatifs', 'Create repository': 'Créer le dépôt', 'Repository list': 'Liste des dépôts', 'Owner': 'Propriétaire', 'Shared': 'Partagé', 'No description has been provided.': 'Aucune description fournie.', 'No description provided.': 'Aucune description fournie.',
    'file': 'fichier', 'files': 'fichiers', 'shared user': 'utilisateur partagé', 'shared users': 'utilisateurs partagés', 'user': 'utilisateur', 'users': 'utilisateurs', 'item': 'élément', 'items': 'éléments', 'Upload': 'Téléverser', 'Download': 'Télécharger', 'Delete': 'Supprimer', 'Owner: {{name}}': 'Propriétaire : {{name}}', 'Deleted account': 'Compte supprimé', 'Updated {{date}}': 'Mis à jour le {{date}}', 'No files yet': 'Aucun fichier', 'No repositories to display': 'Aucun dépôt à afficher', 'No user has created a repository yet.': 'Aucun utilisateur n’a encore créé de dépôt.', 'Create your first personal repository, or ask another owner to grant view permission.': 'Créez votre premier dépôt personnel ou demandez à un propriétaire de vous accorder l’accès en lecture.',
    'ADMIN CONSOLE': 'CONSOLE D’ADMINISTRATION', 'Admin dashboard': 'Tableau de bord administrateur', 'Manage accounts, user-owned repositories, permission grants, and activity across RecordDrive.': 'Gérez les comptes, les dépôts utilisateurs, les autorisations et l’activité de RecordDrive.', 'Dashboard': 'Tableau de bord', 'Repositories': 'Dépôts', 'Accounts': 'Comptes', 'Admin navigation': 'Navigation administrateur', 'Member accounts': 'Comptes membres', 'Registered regular user accounts': 'Comptes utilisateurs standards enregistrés', 'User-owned file spaces': 'Espaces de fichiers appartenant aux utilisateurs', 'Files': 'Fichiers', 'All uploaded files': 'Tous les fichiers téléversés', 'Local disk usage': 'Utilisation du disque local', 'RECENT ACTIVITY': 'ACTIVITÉ RÉCENTE', 'Recent activity': 'Activité récente', 'Sign in activity': 'Connexion', 'Account created': 'Compte créé', 'Account deleted': 'Compte supprimé', 'Repository created': 'Dépôt créé', 'Repository deleted': 'Dépôt supprimé', 'Permission granted': 'Autorisation accordée', 'Permission updated': 'Autorisation mise à jour', 'Permission revoked': 'Autorisation révoquée', 'File uploaded': 'Fichier téléversé', 'File deleted': 'Fichier supprimé', 'HTTPS settings updated': 'Paramètres HTTPS mis à jour', 'No activity has been recorded yet.': 'Aucune activité n’a encore été enregistrée.',
    'REPOSITORY MANAGEMENT': 'GESTION DES DÉPÔTS', 'Repository management': 'Gestion des dépôts', 'Repositories are created by regular users. Administrators can inspect, manage permissions, and permanently remove any repository.': 'Les dépôts sont créés par les utilisateurs standards. Les administrateurs peuvent les consulter, gérer les autorisations et les supprimer définitivement.', 'REPOSITORIES': 'DÉPÔTS', 'All user repositories': 'Tous les dépôts utilisateurs', 'Repository creation is intentionally unavailable to administrators.': 'La création de dépôts est volontairement désactivée pour les administrateurs.', 'Permissions': 'Autorisations', 'Permanently delete the \'{{name}}\' repository and all of its files? This action cannot be undone.': 'Supprimer définitivement le dépôt « {{name}} » et tous ses fichiers ? Cette action est irréversible.', 'No user repositories have been created yet.': 'Aucun dépôt utilisateur n’a encore été créé.',
    'ACCOUNT MANAGEMENT': 'GESTION DES COMPTES', 'Account management': 'Gestion des comptes', 'Create and manage regular user accounts that can own repositories and receive permission grants.': 'Créez et gérez des comptes utilisateurs standards pouvant posséder des dépôts et recevoir des autorisations.', 'NEW ACCOUNT': 'NOUVEAU COMPTE', 'Create account': 'Créer un compte', 'Display name': 'Nom affiché', 'e.g. Jordan Lee': 'ex. Jordan Lee', 'e.g. jordan.lee': 'ex. jordan.lee', 'Lowercase letters, numbers, periods, underscores, and hyphens · 3–32 characters': 'Lettres minuscules, chiffres, points, tirets bas et traits d’union · 3 à 32 caractères', 'Initial password': 'Mot de passe initial', 'Use at least 8 characters and share the password securely with the user.': 'Utilisez au moins 8 caractères et transmettez le mot de passe de façon sécurisée.', 'USERS': 'UTILISATEURS', 'Registered accounts': 'Comptes enregistrés', 'Account': 'Compte', 'Role': 'Rôle', 'Uploads': 'Téléversements', 'Created': 'Créé', 'Actions': 'Actions', 'Protected': 'Protégé', 'Delete this account? Permission grants will be removed, owned repositories will become unassigned, and uploaded files will remain in place.': 'Supprimer ce compte ? Les autorisations seront retirées, les dépôts possédés deviendront non attribués et les fichiers téléversés seront conservés.', 'Use 3-32 lowercase letters, numbers, periods, underscores, or hyphens for the username.': 'Utilisez 3 à 32 lettres minuscules, chiffres, points, tirets bas ou traits d’union pour le nom d’utilisateur.', 'The display name must be between 2 and 50 characters.': 'Le nom affiché doit contenir entre 2 et 50 caractères.', 'The password must be between 8 and 128 characters.': 'Le mot de passe doit contenir entre 8 et 128 caractères.', 'That username is already in use.': 'Ce nom d’utilisateur est déjà utilisé.', 'Created the account for {{name}}.': 'Le compte de {{name}} a été créé.', 'The account to delete could not be found.': 'Le compte à supprimer est introuvable.', 'Administrator accounts cannot be deleted.': 'Les comptes administrateurs ne peuvent pas être supprimés.', 'Deleted the account for {{name}}.': 'Le compte de {{name}} a été supprimé.',
    'REPOSITORY PERMISSIONS': 'AUTORISATIONS DU DÉPÔT', '{{name}} access': 'Accès à {{name}}', 'Grant each user only the repository actions they need. The owner and administrators always retain every permission.': 'Accordez à chaque utilisateur uniquement les actions nécessaires. Le propriétaire et les administrateurs conservent toutes les autorisations.', '← Back': '← Retour', 'Open repository': 'Ouvrir le dépôt', 'OWNER': 'PROPRIÉTAIRE', 'Ownership is currently unassigned.': 'Aucun propriétaire n’est actuellement attribué.', 'View': 'Voir', 'Open the repository and see file metadata.': 'Ouvrir le dépôt et consulter les métadonnées.', 'Add files through the upload endpoint.': 'Ajouter des fichiers via le téléversement.', 'Download stored file contents.': 'Télécharger le contenu des fichiers.', 'Delete files and permanently delete the repository.': 'Supprimer des fichiers et le dépôt définitivement.', 'NEW GRANT': 'NOUVELLE AUTORISATION', 'Share with a user': 'Partager avec un utilisateur', 'User account': 'Compte utilisateur', 'Select a user': 'Sélectionnez un utilisateur', 'Allowed actions': 'Actions autorisées', 'Open and browse': 'Ouvrir et parcourir', 'Add new files': 'Ajouter des fichiers', 'Retrieve file data': 'Récupérer les données', 'Files and repository': 'Fichiers et dépôt', 'Save permission grant': 'Enregistrer l’autorisation', 'Every eligible user already has a permission grant.': 'Tous les utilisateurs éligibles disposent déjà d’une autorisation.', 'Update or revoke an existing grant below.': 'Mettez à jour ou révoquez une autorisation ci-dessous.', 'CURRENT GRANTS': 'AUTORISATIONS ACTUELLES', 'Shared users': 'Utilisateurs partagés', 'Updated': 'Mis à jour', 'Update': 'Mettre à jour', 'Revoke': 'Révoquer', 'Revoke every permission for {{name}}?': 'Révoquer toutes les autorisations de {{name}} ?', 'This repository has not been shared with another user.': 'Ce dépôt n’a été partagé avec aucun autre utilisateur.',
    'The repository name must be between 2 and 60 characters.': 'Le nom du dépôt doit contenir entre 2 et 60 caractères.', 'The description must be 300 characters or fewer.': 'La description doit contenir au maximum 300 caractères.', 'A repository with that name already exists.': 'Un dépôt portant ce nom existe déjà.', 'Created your {{name}} repository.': 'Votre dépôt {{name}} a été créé.', 'The selected user account could not be granted access.': 'L’accès n’a pas pu être accordé au compte sélectionné.', 'Select at least one permission.': 'Sélectionnez au moins une autorisation.', 'Saved repository permissions for {{name}}.': 'Les autorisations de {{name}} ont été enregistrées.', 'The selected user account could not be found.': 'Le compte utilisateur sélectionné est introuvable.', 'Select at least one permission or revoke access.': 'Sélectionnez au moins une autorisation ou révoquez l’accès.', 'Updated repository permissions for {{name}}.': 'Les autorisations de {{name}} ont été mises à jour.', "Revoked {{name}}'s repository permissions.": 'Les autorisations de {{name}} ont été révoquées.', 'No permission grant was found for that account.': 'Aucune autorisation n’a été trouvée pour ce compte.',
    'Administrator access': 'Accès administrateur', 'Owner access': 'Accès propriétaire', 'Shared access': 'Accès partagé', 'Manage the files in this repository securely.': 'Gérez les fichiers de ce dépôt en toute sécurité.', '{{count}} file': '{{count}} fichier', '{{count}} files': '{{count}} fichiers', '{{size}} used': '{{size}} utilisés', '{{count}} shared user': '{{count}} utilisateur partagé', '{{count}} shared users': '{{count}} utilisateurs partagés', 'Repository summary': 'Résumé du dépôt', 'Manage permissions': 'Gérer les autorisations', 'Permanently delete this repository and every stored file? This action cannot be undone.': 'Supprimer définitivement ce dépôt et tous les fichiers stockés ? Cette action est irréversible.', 'Delete repository': 'Supprimer le dépôt', 'Navigation controls': 'Commandes de navigation', 'Back': 'Retour', 'Refresh': 'Actualiser', 'Current location': 'Emplacement actuel', 'Search in {{name}}': 'Rechercher dans {{name}}', 'Search repository files': 'Rechercher dans les fichiers', 'Clear search': 'Effacer la recherche', 'Upload files': 'Téléverser des fichiers', 'Permanently delete the selected file?': 'Supprimer définitivement le fichier sélectionné ?', 'View-only access': 'Accès en lecture seule', 'No item selected': 'Aucun élément sélectionné', 'Sort by': 'Trier par', 'Sort files': 'Trier les fichiers', 'Newest first': 'Plus récents', 'Oldest first': 'Plus anciens', 'Name A–Z': 'Nom A–Z', 'Name Z–A': 'Nom Z–A', 'Largest first': 'Plus volumineux', 'Smallest first': 'Plus petits', 'File view': 'Affichage des fichiers', 'List view': 'Vue en liste', 'Icon view': 'Vue en icônes',
    'File upload': 'Téléversement de fichiers', 'UPLOAD': 'TÉLÉVERSEMENT', 'Add files to this repository': 'Ajouter des fichiers à ce dépôt', 'Drag files here or choose them from your device.': 'Glissez les fichiers ici ou choisissez-les sur votre appareil.', 'Close upload panel': 'Fermer le panneau de téléversement', 'Drop files here': 'Déposez les fichiers ici', 'Up to {{size}} MB per file · Up to {{count}} files at a time': 'Jusqu’à {{size}} Mo par fichier · {{count}} fichiers à la fois', 'Choose from device': 'Choisir sur l’appareil', 'Upload selected files': 'Téléverser les fichiers sélectionnés', 'This repository': 'Ce dépôt', 'All files': 'Tous les fichiers', 'Images': 'Images', 'Documents': 'Documents', 'Media': 'Médias', 'Archives': 'Archives', 'Other': 'Autres', '{{count}} file is stored in this repository.': '{{count}} fichier est stocké dans ce dépôt.', '{{count}} files are stored in this repository.': '{{count}} fichiers sont stockés dans ce dépôt.', 'File categories': 'Catégories de fichiers', 'File list': 'Liste des fichiers', 'Search results for “{{search}}”': 'Résultats pour « {{search}} »', 'Search:': 'Recherche :', 'Name': 'Nom', 'Uploaded': 'Téléversé', 'Type': 'Type', 'Size': 'Taille', 'Uploader': 'Auteur', 'Image': 'Image', 'Video': 'Vidéo', 'Audio': 'Audio', 'Archive': 'Archive', 'Spreadsheet': 'Feuille de calcul', 'Presentation': 'Présentation', 'PDF document': 'Document PDF', 'Document': 'Document', 'File': 'Fichier', 'Select': 'Sélectionner', 'Select {{name}}': 'Sélectionner {{name}}', 'Click once to select; double-click to download': 'Cliquez une fois pour sélectionner, deux fois pour télécharger', 'Click to select': 'Cliquez pour sélectionner', 'Download {{name}}': 'Télécharger {{name}}', 'More options': 'Plus d’options', 'More actions for {{name}}': 'Plus d’actions pour {{name}}', "Permanently delete '{{name}}'?": 'Supprimer définitivement « {{name}} » ?', 'No files match this category': 'Aucun fichier ne correspond à cette catégorie', 'Choose another file type or upload a new file.': 'Choisissez un autre type ou téléversez un nouveau fichier.', 'No search results': 'Aucun résultat', 'This repository is empty': 'Ce dépôt est vide', 'Try another name or return to all files.': 'Essayez un autre nom ou revenez à tous les fichiers.', 'Upload the first file to share it with the team.': 'Téléversez le premier fichier pour le partager avec l’équipe.', 'View all files': 'Voir tous les fichiers', 'File details': 'Détails du fichier', 'Select a file': 'Sélectionnez un fichier', 'File type, size, uploader, and available actions will appear here.': 'Le type, la taille, l’auteur et les actions disponibles apparaîtront ici.', 'Details': 'Détails', 'Clear selection': 'Effacer la sélection', 'File type': 'Type de fichier', 'Delete file': 'Supprimer le fichier', 'Uploading…': 'Téléversement…', '1 selected · {{name}}': '1 sélectionné · {{name}}',
    'Select at least one file to upload.': 'Sélectionnez au moins un fichier à téléverser.', '{{count}} file(s) uploaded successfully.': '{{count}} fichier(s) téléversé(s) avec succès.', 'File not found': 'Fichier introuvable', 'The requested file does not exist.': 'Le fichier demandé n’existe pas.', 'File data missing': 'Données du fichier manquantes', 'The file record exists, but its data could not be found on disk.': 'L’enregistrement existe, mais les données sont introuvables sur le disque.', 'The file to delete could not be found.': 'Le fichier à supprimer est introuvable.', '{{name}} was deleted.': '{{name}} a été supprimé.', 'Deleted the {{name}} repository and its files.': 'Le dépôt {{name}} et ses fichiers ont été supprimés.',
    'LANGUAGE AND REGION': 'LANGUE ET RÉGION', 'Language settings': 'Paramètres de langue', 'Choose the language used across RecordDrive. The default follows your browser language.': 'Choisissez la langue utilisée dans RecordDrive. Par défaut, elle suit celle du navigateur.', 'Language preference': 'Préférence de langue', 'Use browser language': 'Utiliser la langue du navigateur', 'Browser language': 'Langue du navigateur', 'Saved preference': 'Préférence enregistrée', 'Current source': 'Source actuelle', 'Save language': 'Enregistrer la langue', 'Your selection is stored in this browser and remains available after signing out.': 'Votre sélection est conservée dans ce navigateur, même après déconnexion.', 'Language preference updated.': 'La préférence de langue a été mise à jour.', 'The selected language is not supported.': 'La langue sélectionnée n’est pas prise en charge.',
    'Page not found': 'Page introuvable', 'The requested page does not exist or has been moved.': 'La page demandée n’existe pas ou a été déplacée.', 'Upload failed': 'Échec du téléversement', 'An error occurred while uploading the file.': 'Une erreur s’est produite pendant le téléversement.', 'Each file can be up to {{size}} MB.': 'Chaque fichier peut faire jusqu’à {{size}} Mo.', 'You can upload up to {{count}} files at a time.': 'Vous pouvez téléverser jusqu’à {{count}} fichiers à la fois.', 'Server error': 'Erreur du serveur', 'An error occurred while processing the request.': 'Une erreur s’est produite pendant le traitement de la demande.', 'Access denied': 'Accès refusé', 'Only administrators can access this page.': 'Seuls les administrateurs peuvent accéder à cette page.', 'Only regular users can create personal repositories.': 'Seuls les utilisateurs standards peuvent créer des dépôts personnels.', 'Request could not be verified': 'La demande n’a pas pu être vérifiée', 'The security token is invalid or has expired. Refresh the page and try again.': 'Le jeton de sécurité est invalide ou expiré. Actualisez la page et réessayez.', 'RECORDDRIVE ERROR': 'ERREUR RECORDDRIVE', 'Go to My Drive': 'Aller à Mon Drive', 'Go to sign in': 'Aller à la connexion'
  },
  es: {
    'My Drive': 'Mi Drive', 'Admin': 'Administración', 'Settings': 'Configuración', 'Primary navigation': 'Navegación principal', 'RecordDrive home': 'Inicio de RecordDrive', 'Administrator': 'Administrador', 'User': 'Usuario', 'Sign out': 'Cerrar sesión', 'Secure team file storage': 'Almacenamiento seguro de archivos para equipos', 'Dismiss notification': 'Cerrar notificación',
    'Show': 'Mostrar', 'Hide': 'Ocultar', 'Show password': 'Mostrar contraseña', 'Hide password': 'Ocultar contraseña', 'Do you want to continue?': '¿Deseas continuar?',
    'Sign in': 'Iniciar sesión', 'TEAM CLOUD STORAGE': 'ALMACENAMIENTO EN LA NUBE PARA EQUIPOS', 'Keep every record organized,': 'Mantén cada archivo organizado,', 'securely together.': 'juntos y de forma segura.', 'Organize files in team repositories and give access only to the people who need it.': 'Organiza archivos en repositorios de equipo y permite el acceso solo a quienes lo necesitan.', 'Role-based access': 'Acceso por roles', 'File uploads': 'Carga de archivos', 'Activity history': 'Historial de actividad', 'WELCOME BACK': 'BIENVENIDO DE NUEVO', 'Sign in to RecordDrive': 'Inicia sesión en RecordDrive', 'Use the account provided by your administrator.': 'Usa la cuenta proporcionada por tu administrador.', 'Username': 'Nombre de usuario', 'Enter your username': 'Introduce tu nombre de usuario', 'Password': 'Contraseña', 'Enter your password': 'Introduce tu contraseña', 'Contact your RecordDrive administrator if you need an account or repository access.': 'Contacta con tu administrador de RecordDrive si necesitas una cuenta o acceso a un repositorio.', 'The username or password is incorrect.': 'El nombre de usuario o la contraseña son incorrectos.', 'Too many sign-in attempts. Try again in about {{minutes}} minute(s).': 'Demasiados intentos de inicio de sesión. Inténtalo de nuevo en unos {{minutes}} minuto(s).',
    'MY RECORDDRIVE': 'MI RECORDDRIVE', "{{name}}'s Drive": 'Drive de {{name}}', 'Administrator access includes every repository and every repository action.': 'El acceso de administrador incluye todos los repositorios y todas las acciones.', 'Create personal repositories and open only repositories shared with your account.': 'Crea repositorios personales y abre solo los compartidos con tu cuenta.', 'Review all repositories': 'Revisar todos los repositorios', '+ New personal repository': '+ Nuevo repositorio personal', 'Visible repositories': 'Repositorios visibles', 'Total files': 'Archivos totales', 'Storage used': 'Almacenamiento usado', 'PERSONAL REPOSITORY': 'REPOSITORIO PERSONAL', 'Create a repository': 'Crear un repositorio', 'You become the owner and receive every permission automatically.': 'Te conviertes en propietario y recibes todos los permisos automáticamente.', 'Repository name': 'Nombre del repositorio', 'e.g. Project Archive': 'p. ej., Archivo del proyecto', 'Description': 'Descripción', 'Optional purpose or notes': 'Propósito o notas opcionales', 'Create repository': 'Crear repositorio', 'Repository list': 'Lista de repositorios', 'Owner': 'Propietario', 'Shared': 'Compartido', 'No description has been provided.': 'No se ha proporcionado una descripción.', 'No description provided.': 'Sin descripción.',
    'file': 'archivo', 'files': 'archivos', 'shared user': 'usuario compartido', 'shared users': 'usuarios compartidos', 'user': 'usuario', 'users': 'usuarios', 'item': 'elemento', 'items': 'elementos', 'Upload': 'Cargar', 'Download': 'Descargar', 'Delete': 'Eliminar', 'Owner: {{name}}': 'Propietario: {{name}}', 'Deleted account': 'Cuenta eliminada', 'Updated {{date}}': 'Actualizado el {{date}}', 'No files yet': 'Aún no hay archivos', 'No repositories to display': 'No hay repositorios para mostrar', 'No user has created a repository yet.': 'Ningún usuario ha creado un repositorio todavía.', 'Create your first personal repository, or ask another owner to grant view permission.': 'Crea tu primer repositorio personal o pide a otro propietario que te conceda permiso de visualización.',
    'ADMIN CONSOLE': 'CONSOLA DE ADMINISTRACIÓN', 'Admin dashboard': 'Panel de administración', 'Manage accounts, user-owned repositories, permission grants, and activity across RecordDrive.': 'Gestiona cuentas, repositorios de usuarios, permisos y actividad de RecordDrive.', 'Dashboard': 'Panel', 'Repositories': 'Repositorios', 'Accounts': 'Cuentas', 'Admin navigation': 'Navegación de administración', 'Member accounts': 'Cuentas de miembros', 'Registered regular user accounts': 'Cuentas de usuario normales registradas', 'User-owned file spaces': 'Espacios de archivos propiedad de usuarios', 'Files': 'Archivos', 'All uploaded files': 'Todos los archivos cargados', 'Local disk usage': 'Uso del disco local', 'RECENT ACTIVITY': 'ACTIVIDAD RECIENTE', 'Recent activity': 'Actividad reciente', 'Sign in activity': 'Inicio de sesión', 'Account created': 'Cuenta creada', 'Account deleted': 'Cuenta eliminada', 'Repository created': 'Repositorio creado', 'Repository deleted': 'Repositorio eliminado', 'Permission granted': 'Permiso concedido', 'Permission updated': 'Permiso actualizado', 'Permission revoked': 'Permiso revocado', 'File uploaded': 'Archivo cargado', 'File deleted': 'Archivo eliminado', 'HTTPS settings updated': 'Configuración HTTPS actualizada', 'No activity has been recorded yet.': 'Aún no se ha registrado actividad.',
    'REPOSITORY MANAGEMENT': 'GESTIÓN DE REPOSITORIOS', 'Repository management': 'Gestión de repositorios', 'Repositories are created by regular users. Administrators can inspect, manage permissions, and permanently remove any repository.': 'Los repositorios los crean los usuarios normales. Los administradores pueden inspeccionarlos, gestionar permisos y eliminarlos permanentemente.', 'REPOSITORIES': 'REPOSITORIOS', 'All user repositories': 'Todos los repositorios de usuarios', 'Repository creation is intentionally unavailable to administrators.': 'La creación de repositorios está deshabilitada intencionadamente para los administradores.', 'Permissions': 'Permisos', 'Permanently delete the \'{{name}}\' repository and all of its files? This action cannot be undone.': '¿Eliminar permanentemente el repositorio «{{name}}» y todos sus archivos? Esta acción no se puede deshacer.', 'No user repositories have been created yet.': 'Aún no se han creado repositorios de usuarios.',
    'ACCOUNT MANAGEMENT': 'GESTIÓN DE CUENTAS', 'Account management': 'Gestión de cuentas', 'Create and manage regular user accounts that can own repositories and receive permission grants.': 'Crea y gestiona cuentas de usuario normales que pueden poseer repositorios y recibir permisos.', 'NEW ACCOUNT': 'NUEVA CUENTA', 'Create account': 'Crear cuenta', 'Display name': 'Nombre visible', 'e.g. Jordan Lee': 'p. ej., Jordan Lee', 'e.g. jordan.lee': 'p. ej., jordan.lee', 'Lowercase letters, numbers, periods, underscores, and hyphens · 3–32 characters': 'Letras minúsculas, números, puntos, guiones bajos y guiones · 3–32 caracteres', 'Initial password': 'Contraseña inicial', 'Use at least 8 characters and share the password securely with the user.': 'Usa al menos 8 caracteres y comparte la contraseña de forma segura.', 'USERS': 'USUARIOS', 'Registered accounts': 'Cuentas registradas', 'Account': 'Cuenta', 'Role': 'Rol', 'Uploads': 'Cargas', 'Created': 'Creada', 'Actions': 'Acciones', 'Protected': 'Protegida', 'Delete this account? Permission grants will be removed, owned repositories will become unassigned, and uploaded files will remain in place.': '¿Eliminar esta cuenta? Se retirarán los permisos, los repositorios propios quedarán sin asignar y los archivos cargados permanecerán.', 'Use 3-32 lowercase letters, numbers, periods, underscores, or hyphens for the username.': 'Usa entre 3 y 32 letras minúsculas, números, puntos, guiones bajos o guiones para el nombre de usuario.', 'The display name must be between 2 and 50 characters.': 'El nombre visible debe tener entre 2 y 50 caracteres.', 'The password must be between 8 and 128 characters.': 'La contraseña debe tener entre 8 y 128 caracteres.', 'That username is already in use.': 'Ese nombre de usuario ya está en uso.', 'Created the account for {{name}}.': 'Se creó la cuenta de {{name}}.', 'The account to delete could not be found.': 'No se encontró la cuenta que se iba a eliminar.', 'Administrator accounts cannot be deleted.': 'Las cuentas de administrador no se pueden eliminar.', 'Deleted the account for {{name}}.': 'Se eliminó la cuenta de {{name}}.',
    'REPOSITORY PERMISSIONS': 'PERMISOS DEL REPOSITORIO', '{{name}} access': 'Acceso a {{name}}', 'Grant each user only the repository actions they need. The owner and administrators always retain every permission.': 'Concede a cada usuario solo las acciones que necesita. El propietario y los administradores siempre conservan todos los permisos.', '← Back': '← Volver', 'Open repository': 'Abrir repositorio', 'OWNER': 'PROPIETARIO', 'Ownership is currently unassigned.': 'Actualmente no hay propietario asignado.', 'View': 'Ver', 'Open the repository and see file metadata.': 'Abrir el repositorio y ver metadatos.', 'Add files through the upload endpoint.': 'Añadir archivos mediante la carga.', 'Download stored file contents.': 'Descargar el contenido almacenado.', 'Delete files and permanently delete the repository.': 'Eliminar archivos y el repositorio permanentemente.', 'NEW GRANT': 'NUEVO PERMISO', 'Share with a user': 'Compartir con un usuario', 'User account': 'Cuenta de usuario', 'Select a user': 'Selecciona un usuario', 'Allowed actions': 'Acciones permitidas', 'Open and browse': 'Abrir y explorar', 'Add new files': 'Añadir archivos', 'Retrieve file data': 'Obtener datos', 'Files and repository': 'Archivos y repositorio', 'Save permission grant': 'Guardar permiso', 'Every eligible user already has a permission grant.': 'Todos los usuarios aptos ya tienen permisos.', 'Update or revoke an existing grant below.': 'Actualiza o revoca un permiso existente abajo.', 'CURRENT GRANTS': 'PERMISOS ACTUALES', 'Shared users': 'Usuarios compartidos', 'Updated': 'Actualizado', 'Update': 'Actualizar', 'Revoke': 'Revocar', 'Revoke every permission for {{name}}?': '¿Revocar todos los permisos de {{name}}?', 'This repository has not been shared with another user.': 'Este repositorio no se ha compartido con otro usuario.',
    'The repository name must be between 2 and 60 characters.': 'El nombre del repositorio debe tener entre 2 y 60 caracteres.', 'The description must be 300 characters or fewer.': 'La descripción debe tener 300 caracteres o menos.', 'A repository with that name already exists.': 'Ya existe un repositorio con ese nombre.', 'Created your {{name}} repository.': 'Se creó tu repositorio {{name}}.', 'The selected user account could not be granted access.': 'No se pudo conceder acceso a la cuenta seleccionada.', 'Select at least one permission.': 'Selecciona al menos un permiso.', 'Saved repository permissions for {{name}}.': 'Se guardaron los permisos de {{name}}.', 'The selected user account could not be found.': 'No se encontró la cuenta seleccionada.', 'Select at least one permission or revoke access.': 'Selecciona al menos un permiso o revoca el acceso.', 'Updated repository permissions for {{name}}.': 'Se actualizaron los permisos de {{name}}.', "Revoked {{name}}'s repository permissions.": 'Se revocaron los permisos de {{name}}.', 'No permission grant was found for that account.': 'No se encontró ningún permiso para esa cuenta.',
    'Administrator access': 'Acceso de administrador', 'Owner access': 'Acceso de propietario', 'Shared access': 'Acceso compartido', 'Manage the files in this repository securely.': 'Gestiona los archivos de este repositorio de forma segura.', '{{count}} file': '{{count}} archivo', '{{count}} files': '{{count}} archivos', '{{size}} used': '{{size}} usados', '{{count}} shared user': '{{count}} usuario compartido', '{{count}} shared users': '{{count}} usuarios compartidos', 'Repository summary': 'Resumen del repositorio', 'Manage permissions': 'Gestionar permisos', 'Permanently delete this repository and every stored file? This action cannot be undone.': '¿Eliminar permanentemente este repositorio y todos los archivos almacenados? Esta acción no se puede deshacer.', 'Delete repository': 'Eliminar repositorio', 'Navigation controls': 'Controles de navegación', 'Back': 'Volver', 'Refresh': 'Actualizar', 'Current location': 'Ubicación actual', 'Search in {{name}}': 'Buscar en {{name}}', 'Search repository files': 'Buscar archivos del repositorio', 'Clear search': 'Borrar búsqueda', 'Upload files': 'Cargar archivos', 'Permanently delete the selected file?': '¿Eliminar permanentemente el archivo seleccionado?', 'View-only access': 'Acceso de solo lectura', 'No item selected': 'Ningún elemento seleccionado', 'Sort by': 'Ordenar por', 'Sort files': 'Ordenar archivos', 'Newest first': 'Más recientes', 'Oldest first': 'Más antiguos', 'Name A–Z': 'Nombre A–Z', 'Name Z–A': 'Nombre Z–A', 'Largest first': 'Más grandes', 'Smallest first': 'Más pequeños', 'File view': 'Vista de archivos', 'List view': 'Vista de lista', 'Icon view': 'Vista de iconos',
    'File upload': 'Carga de archivos', 'UPLOAD': 'CARGA', 'Add files to this repository': 'Añadir archivos a este repositorio', 'Drag files here or choose them from your device.': 'Arrastra archivos aquí o selecciónalos desde tu dispositivo.', 'Close upload panel': 'Cerrar panel de carga', 'Drop files here': 'Suelta los archivos aquí', 'Up to {{size}} MB per file · Up to {{count}} files at a time': 'Hasta {{size}} MB por archivo · Hasta {{count}} archivos a la vez', 'Choose from device': 'Elegir del dispositivo', 'Upload selected files': 'Cargar archivos seleccionados', 'This repository': 'Este repositorio', 'All files': 'Todos los archivos', 'Images': 'Imágenes', 'Documents': 'Documentos', 'Media': 'Multimedia', 'Archives': 'Archivos comprimidos', 'Other': 'Otros', '{{count}} file is stored in this repository.': 'Hay {{count}} archivo almacenado en este repositorio.', '{{count}} files are stored in this repository.': 'Hay {{count}} archivos almacenados en este repositorio.', 'File categories': 'Categorías de archivo', 'File list': 'Lista de archivos', 'Search results for “{{search}}”': 'Resultados para «{{search}}»', 'Search:': 'Búsqueda:', 'Name': 'Nombre', 'Uploaded': 'Cargado', 'Type': 'Tipo', 'Size': 'Tamaño', 'Uploader': 'Autor', 'Image': 'Imagen', 'Video': 'Vídeo', 'Audio': 'Audio', 'Archive': 'Archivo comprimido', 'Spreadsheet': 'Hoja de cálculo', 'Presentation': 'Presentación', 'PDF document': 'Documento PDF', 'Document': 'Documento', 'File': 'Archivo', 'Select': 'Seleccionar', 'Select {{name}}': 'Seleccionar {{name}}', 'Click once to select; double-click to download': 'Haz clic una vez para seleccionar y dos para descargar', 'Click to select': 'Haz clic para seleccionar', 'Download {{name}}': 'Descargar {{name}}', 'More options': 'Más opciones', 'More actions for {{name}}': 'Más acciones para {{name}}', "Permanently delete '{{name}}'?": '¿Eliminar permanentemente «{{name}}»?', 'No files match this category': 'Ningún archivo coincide con esta categoría', 'Choose another file type or upload a new file.': 'Elige otro tipo de archivo o carga uno nuevo.', 'No search results': 'Sin resultados', 'This repository is empty': 'Este repositorio está vacío', 'Try another name or return to all files.': 'Prueba con otro nombre o vuelve a todos los archivos.', 'Upload the first file to share it with the team.': 'Carga el primer archivo para compartirlo con el equipo.', 'View all files': 'Ver todos los archivos', 'File details': 'Detalles del archivo', 'Select a file': 'Selecciona un archivo', 'File type, size, uploader, and available actions will appear here.': 'El tipo, tamaño, autor y acciones disponibles aparecerán aquí.', 'Details': 'Detalles', 'Clear selection': 'Borrar selección', 'File type': 'Tipo de archivo', 'Delete file': 'Eliminar archivo', 'Uploading…': 'Cargando…', '1 selected · {{name}}': '1 seleccionado · {{name}}',
    'Select at least one file to upload.': 'Selecciona al menos un archivo para cargar.', '{{count}} file(s) uploaded successfully.': 'Se cargaron correctamente {{count}} archivo(s).', 'File not found': 'Archivo no encontrado', 'The requested file does not exist.': 'El archivo solicitado no existe.', 'File data missing': 'Faltan los datos del archivo', 'The file record exists, but its data could not be found on disk.': 'El registro existe, pero no se encontraron los datos en el disco.', 'The file to delete could not be found.': 'No se encontró el archivo que se iba a eliminar.', '{{name}} was deleted.': 'Se eliminó {{name}}.', 'Deleted the {{name}} repository and its files.': 'Se eliminaron el repositorio {{name}} y sus archivos.',
    'LANGUAGE AND REGION': 'IDIOMA Y REGIÓN', 'Language settings': 'Configuración de idioma', 'Choose the language used across RecordDrive. The default follows your browser language.': 'Elige el idioma usado en RecordDrive. De forma predeterminada, sigue el idioma del navegador.', 'Language preference': 'Preferencia de idioma', 'Use browser language': 'Usar el idioma del navegador', 'Browser language': 'Idioma del navegador', 'Saved preference': 'Preferencia guardada', 'Current source': 'Fuente actual', 'Save language': 'Guardar idioma', 'Your selection is stored in this browser and remains available after signing out.': 'Tu selección se guarda en este navegador y permanece disponible tras cerrar sesión.', 'Language preference updated.': 'Se actualizó la preferencia de idioma.', 'The selected language is not supported.': 'El idioma seleccionado no es compatible.',
    'Page not found': 'Página no encontrada', 'The requested page does not exist or has been moved.': 'La página solicitada no existe o se ha movido.', 'Upload failed': 'Error de carga', 'An error occurred while uploading the file.': 'Se produjo un error al cargar el archivo.', 'Each file can be up to {{size}} MB.': 'Cada archivo puede tener hasta {{size}} MB.', 'You can upload up to {{count}} files at a time.': 'Puedes cargar hasta {{count}} archivos a la vez.', 'Server error': 'Error del servidor', 'An error occurred while processing the request.': 'Se produjo un error al procesar la solicitud.', 'Access denied': 'Acceso denegado', 'Only administrators can access this page.': 'Solo los administradores pueden acceder a esta página.', 'Only regular users can create personal repositories.': 'Solo los usuarios normales pueden crear repositorios personales.', 'Request could not be verified': 'No se pudo verificar la solicitud', 'The security token is invalid or has expired. Refresh the page and try again.': 'El token de seguridad no es válido o ha caducado. Actualiza la página e inténtalo de nuevo.', 'RECORDDRIVE ERROR': 'ERROR DE RECORDDRIVE', 'Go to My Drive': 'Ir a Mi Drive', 'Go to sign in': 'Ir al inicio de sesión'
  },
  pt: {
    'My Drive': 'Meu Drive', 'Admin': 'Administração', 'Settings': 'Configurações', 'Primary navigation': 'Navegação principal', 'RecordDrive home': 'Início do RecordDrive', 'Administrator': 'Administrador', 'User': 'Usuário', 'Sign out': 'Sair', 'Secure team file storage': 'Armazenamento seguro de arquivos para equipes', 'Dismiss notification': 'Fechar notificação',
    'Show': 'Mostrar', 'Hide': 'Ocultar', 'Show password': 'Mostrar senha', 'Hide password': 'Ocultar senha', 'Do you want to continue?': 'Deseja continuar?',
    'Sign in': 'Entrar', 'TEAM CLOUD STORAGE': 'ARMAZENAMENTO EM NUVEM PARA EQUIPES', 'Keep every record organized,': 'Mantenha todos os arquivos organizados,', 'securely together.': 'juntos e com segurança.', 'Organize files in team repositories and give access only to the people who need it.': 'Organize arquivos em repositórios da equipe e dê acesso somente a quem precisa.', 'Role-based access': 'Acesso por função', 'File uploads': 'Envio de arquivos', 'Activity history': 'Histórico de atividades', 'WELCOME BACK': 'BEM-VINDO DE VOLTA', 'Sign in to RecordDrive': 'Entre no RecordDrive', 'Use the account provided by your administrator.': 'Use a conta fornecida pelo administrador.', 'Username': 'Nome de usuário', 'Enter your username': 'Digite seu nome de usuário', 'Password': 'Senha', 'Enter your password': 'Digite sua senha', 'Contact your RecordDrive administrator if you need an account or repository access.': 'Fale com o administrador do RecordDrive se precisar de uma conta ou acesso a um repositório.', 'The username or password is incorrect.': 'O nome de usuário ou a senha estão incorretos.', 'Too many sign-in attempts. Try again in about {{minutes}} minute(s).': 'Muitas tentativas de login. Tente novamente em cerca de {{minutes}} minuto(s).',
    'MY RECORDDRIVE': 'MEU RECORDDRIVE', "{{name}}'s Drive": 'Drive de {{name}}', 'Administrator access includes every repository and every repository action.': 'O acesso de administrador inclui todos os repositórios e todas as ações.', 'Create personal repositories and open only repositories shared with your account.': 'Crie repositórios pessoais e abra apenas os compartilhados com sua conta.', 'Review all repositories': 'Ver todos os repositórios', '+ New personal repository': '+ Novo repositório pessoal', 'Visible repositories': 'Repositórios visíveis', 'Total files': 'Total de arquivos', 'Storage used': 'Armazenamento usado', 'PERSONAL REPOSITORY': 'REPOSITÓRIO PESSOAL', 'Create a repository': 'Criar um repositório', 'You become the owner and receive every permission automatically.': 'Você se torna o proprietário e recebe todas as permissões automaticamente.', 'Repository name': 'Nome do repositório', 'e.g. Project Archive': 'ex.: Arquivo do projeto', 'Description': 'Descrição', 'Optional purpose or notes': 'Objetivo ou observações opcionais', 'Create repository': 'Criar repositório', 'Repository list': 'Lista de repositórios', 'Owner': 'Proprietário', 'Shared': 'Compartilhado', 'No description has been provided.': 'Nenhuma descrição foi fornecida.', 'No description provided.': 'Sem descrição.',
    'file': 'arquivo', 'files': 'arquivos', 'shared user': 'usuário compartilhado', 'shared users': 'usuários compartilhados', 'user': 'usuário', 'users': 'usuários', 'item': 'item', 'items': 'itens', 'Upload': 'Enviar', 'Download': 'Baixar', 'Delete': 'Excluir', 'Owner: {{name}}': 'Proprietário: {{name}}', 'Deleted account': 'Conta excluída', 'Updated {{date}}': 'Atualizado em {{date}}', 'No files yet': 'Ainda não há arquivos', 'No repositories to display': 'Nenhum repositório para exibir', 'No user has created a repository yet.': 'Nenhum usuário criou um repositório ainda.', 'Create your first personal repository, or ask another owner to grant view permission.': 'Crie seu primeiro repositório pessoal ou peça a outro proprietário permissão de visualização.',
    'ADMIN CONSOLE': 'CONSOLE DE ADMINISTRAÇÃO', 'Admin dashboard': 'Painel do administrador', 'Manage accounts, user-owned repositories, permission grants, and activity across RecordDrive.': 'Gerencie contas, repositórios de usuários, permissões e atividades do RecordDrive.', 'Dashboard': 'Painel', 'Repositories': 'Repositórios', 'Accounts': 'Contas', 'Admin navigation': 'Navegação administrativa', 'Member accounts': 'Contas de membros', 'Registered regular user accounts': 'Contas de usuários comuns registradas', 'User-owned file spaces': 'Espaços de arquivos pertencentes aos usuários', 'Files': 'Arquivos', 'All uploaded files': 'Todos os arquivos enviados', 'Local disk usage': 'Uso do disco local', 'RECENT ACTIVITY': 'ATIVIDADE RECENTE', 'Recent activity': 'Atividade recente', 'Sign in activity': 'Login', 'Account created': 'Conta criada', 'Account deleted': 'Conta excluída', 'Repository created': 'Repositório criado', 'Repository deleted': 'Repositório excluído', 'Permission granted': 'Permissão concedida', 'Permission updated': 'Permissão atualizada', 'Permission revoked': 'Permissão revogada', 'File uploaded': 'Arquivo enviado', 'File deleted': 'Arquivo excluído', 'HTTPS settings updated': 'Configurações HTTPS atualizadas', 'No activity has been recorded yet.': 'Nenhuma atividade foi registrada ainda.',
    'REPOSITORY MANAGEMENT': 'GERENCIAMENTO DE REPOSITÓRIOS', 'Repository management': 'Gerenciamento de repositórios', 'Repositories are created by regular users. Administrators can inspect, manage permissions, and permanently remove any repository.': 'Os repositórios são criados por usuários comuns. Os administradores podem inspecionar, gerenciar permissões e excluir permanentemente qualquer repositório.', 'REPOSITORIES': 'REPOSITÓRIOS', 'All user repositories': 'Todos os repositórios de usuários', 'Repository creation is intentionally unavailable to administrators.': 'A criação de repositórios está intencionalmente indisponível para administradores.', 'Permissions': 'Permissões', 'Permanently delete the \'{{name}}\' repository and all of its files? This action cannot be undone.': 'Excluir permanentemente o repositório “{{name}}” e todos os arquivos? Esta ação não pode ser desfeita.', 'No user repositories have been created yet.': 'Nenhum repositório de usuário foi criado ainda.',
    'ACCOUNT MANAGEMENT': 'GERENCIAMENTO DE CONTAS', 'Account management': 'Gerenciamento de contas', 'Create and manage regular user accounts that can own repositories and receive permission grants.': 'Crie e gerencie contas de usuários comuns que podem possuir repositórios e receber permissões.', 'NEW ACCOUNT': 'NOVA CONTA', 'Create account': 'Criar conta', 'Display name': 'Nome de exibição', 'e.g. Jordan Lee': 'ex.: Jordan Lee', 'e.g. jordan.lee': 'ex.: jordan.lee', 'Lowercase letters, numbers, periods, underscores, and hyphens · 3–32 characters': 'Letras minúsculas, números, pontos, sublinhados e hífens · 3–32 caracteres', 'Initial password': 'Senha inicial', 'Use at least 8 characters and share the password securely with the user.': 'Use pelo menos 8 caracteres e compartilhe a senha de forma segura.', 'USERS': 'USUÁRIOS', 'Registered accounts': 'Contas registradas', 'Account': 'Conta', 'Role': 'Função', 'Uploads': 'Envios', 'Created': 'Criada', 'Actions': 'Ações', 'Protected': 'Protegida', 'Delete this account? Permission grants will be removed, owned repositories will become unassigned, and uploaded files will remain in place.': 'Excluir esta conta? As permissões serão removidas, os repositórios próprios ficarão sem proprietário e os arquivos enviados permanecerão.', 'Use 3-32 lowercase letters, numbers, periods, underscores, or hyphens for the username.': 'Use de 3 a 32 letras minúsculas, números, pontos, sublinhados ou hífens no nome de usuário.', 'The display name must be between 2 and 50 characters.': 'O nome de exibição deve ter entre 2 e 50 caracteres.', 'The password must be between 8 and 128 characters.': 'A senha deve ter entre 8 e 128 caracteres.', 'That username is already in use.': 'Esse nome de usuário já está em uso.', 'Created the account for {{name}}.': 'A conta de {{name}} foi criada.', 'The account to delete could not be found.': 'A conta a ser excluída não foi encontrada.', 'Administrator accounts cannot be deleted.': 'Contas de administrador não podem ser excluídas.', 'Deleted the account for {{name}}.': 'A conta de {{name}} foi excluída.',
    'REPOSITORY PERMISSIONS': 'PERMISSÕES DO REPOSITÓRIO', '{{name}} access': 'Acesso a {{name}}', 'Grant each user only the repository actions they need. The owner and administrators always retain every permission.': 'Conceda a cada usuário somente as ações necessárias. O proprietário e os administradores sempre mantêm todas as permissões.', '← Back': '← Voltar', 'Open repository': 'Abrir repositório', 'OWNER': 'PROPRIETÁRIO', 'Ownership is currently unassigned.': 'No momento, não há proprietário atribuído.', 'View': 'Visualizar', 'Open the repository and see file metadata.': 'Abrir o repositório e ver os metadados.', 'Add files through the upload endpoint.': 'Adicionar arquivos pelo envio.', 'Download stored file contents.': 'Baixar o conteúdo armazenado.', 'Delete files and permanently delete the repository.': 'Excluir arquivos e o repositório permanentemente.', 'NEW GRANT': 'NOVA PERMISSÃO', 'Share with a user': 'Compartilhar com um usuário', 'User account': 'Conta de usuário', 'Select a user': 'Selecione um usuário', 'Allowed actions': 'Ações permitidas', 'Open and browse': 'Abrir e navegar', 'Add new files': 'Adicionar arquivos', 'Retrieve file data': 'Obter dados', 'Files and repository': 'Arquivos e repositório', 'Save permission grant': 'Salvar permissão', 'Every eligible user already has a permission grant.': 'Todos os usuários elegíveis já têm uma permissão.', 'Update or revoke an existing grant below.': 'Atualize ou revogue uma permissão abaixo.', 'CURRENT GRANTS': 'PERMISSÕES ATUAIS', 'Shared users': 'Usuários compartilhados', 'Updated': 'Atualizado', 'Update': 'Atualizar', 'Revoke': 'Revogar', 'Revoke every permission for {{name}}?': 'Revogar todas as permissões de {{name}}?', 'This repository has not been shared with another user.': 'Este repositório não foi compartilhado com outro usuário.',
    'The repository name must be between 2 and 60 characters.': 'O nome do repositório deve ter entre 2 e 60 caracteres.', 'The description must be 300 characters or fewer.': 'A descrição deve ter no máximo 300 caracteres.', 'A repository with that name already exists.': 'Já existe um repositório com esse nome.', 'Created your {{name}} repository.': 'Seu repositório {{name}} foi criado.', 'The selected user account could not be granted access.': 'Não foi possível conceder acesso à conta selecionada.', 'Select at least one permission.': 'Selecione pelo menos uma permissão.', 'Saved repository permissions for {{name}}.': 'As permissões de {{name}} foram salvas.', 'The selected user account could not be found.': 'A conta selecionada não foi encontrada.', 'Select at least one permission or revoke access.': 'Selecione pelo menos uma permissão ou revogue o acesso.', 'Updated repository permissions for {{name}}.': 'As permissões de {{name}} foram atualizadas.', "Revoked {{name}}'s repository permissions.": 'As permissões de {{name}} foram revogadas.', 'No permission grant was found for that account.': 'Nenhuma permissão foi encontrada para essa conta.',
    'Administrator access': 'Acesso de administrador', 'Owner access': 'Acesso de proprietário', 'Shared access': 'Acesso compartilhado', 'Manage the files in this repository securely.': 'Gerencie os arquivos deste repositório com segurança.', '{{count}} file': '{{count}} arquivo', '{{count}} files': '{{count}} arquivos', '{{size}} used': '{{size}} usados', '{{count}} shared user': '{{count}} usuário compartilhado', '{{count}} shared users': '{{count}} usuários compartilhados', 'Repository summary': 'Resumo do repositório', 'Manage permissions': 'Gerenciar permissões', 'Permanently delete this repository and every stored file? This action cannot be undone.': 'Excluir permanentemente este repositório e todos os arquivos armazenados? Esta ação não pode ser desfeita.', 'Delete repository': 'Excluir repositório', 'Navigation controls': 'Controles de navegação', 'Back': 'Voltar', 'Refresh': 'Atualizar', 'Current location': 'Local atual', 'Search in {{name}}': 'Pesquisar em {{name}}', 'Search repository files': 'Pesquisar arquivos do repositório', 'Clear search': 'Limpar pesquisa', 'Upload files': 'Enviar arquivos', 'Permanently delete the selected file?': 'Excluir permanentemente o arquivo selecionado?', 'View-only access': 'Acesso somente para visualização', 'No item selected': 'Nenhum item selecionado', 'Sort by': 'Ordenar por', 'Sort files': 'Ordenar arquivos', 'Newest first': 'Mais recentes', 'Oldest first': 'Mais antigos', 'Name A–Z': 'Nome A–Z', 'Name Z–A': 'Nome Z–A', 'Largest first': 'Maiores primeiro', 'Smallest first': 'Menores primeiro', 'File view': 'Visualização de arquivos', 'List view': 'Visualização em lista', 'Icon view': 'Visualização em ícones',
    'File upload': 'Envio de arquivos', 'UPLOAD': 'ENVIO', 'Add files to this repository': 'Adicionar arquivos a este repositório', 'Drag files here or choose them from your device.': 'Arraste os arquivos para cá ou escolha-os no seu dispositivo.', 'Close upload panel': 'Fechar painel de envio', 'Drop files here': 'Solte os arquivos aqui', 'Up to {{size}} MB per file · Up to {{count}} files at a time': 'Até {{size}} MB por arquivo · Até {{count}} arquivos por vez', 'Choose from device': 'Escolher do dispositivo', 'Upload selected files': 'Enviar arquivos selecionados', 'This repository': 'Este repositório', 'All files': 'Todos os arquivos', 'Images': 'Imagens', 'Documents': 'Documentos', 'Media': 'Mídia', 'Archives': 'Arquivos compactados', 'Other': 'Outros', '{{count}} file is stored in this repository.': '{{count}} arquivo está armazenado neste repositório.', '{{count}} files are stored in this repository.': '{{count}} arquivos estão armazenados neste repositório.', 'File categories': 'Categorias de arquivos', 'File list': 'Lista de arquivos', 'Search results for “{{search}}”': 'Resultados para “{{search}}”', 'Search:': 'Pesquisa:', 'Name': 'Nome', 'Uploaded': 'Enviado', 'Type': 'Tipo', 'Size': 'Tamanho', 'Uploader': 'Autor', 'Image': 'Imagem', 'Video': 'Vídeo', 'Audio': 'Áudio', 'Archive': 'Arquivo compactado', 'Spreadsheet': 'Planilha', 'Presentation': 'Apresentação', 'PDF document': 'Documento PDF', 'Document': 'Documento', 'File': 'Arquivo', 'Select': 'Selecionar', 'Select {{name}}': 'Selecionar {{name}}', 'Click once to select; double-click to download': 'Clique uma vez para selecionar e duas para baixar', 'Click to select': 'Clique para selecionar', 'Download {{name}}': 'Baixar {{name}}', 'More options': 'Mais opções', 'More actions for {{name}}': 'Mais ações para {{name}}', "Permanently delete '{{name}}'?": 'Excluir permanentemente “{{name}}”?', 'No files match this category': 'Nenhum arquivo corresponde a esta categoria', 'Choose another file type or upload a new file.': 'Escolha outro tipo de arquivo ou envie um novo.', 'No search results': 'Nenhum resultado', 'This repository is empty': 'Este repositório está vazio', 'Try another name or return to all files.': 'Tente outro nome ou volte para todos os arquivos.', 'Upload the first file to share it with the team.': 'Envie o primeiro arquivo para compartilhá-lo com a equipe.', 'View all files': 'Ver todos os arquivos', 'File details': 'Detalhes do arquivo', 'Select a file': 'Selecione um arquivo', 'File type, size, uploader, and available actions will appear here.': 'O tipo, tamanho, autor e ações disponíveis aparecerão aqui.', 'Details': 'Detalhes', 'Clear selection': 'Limpar seleção', 'File type': 'Tipo de arquivo', 'Delete file': 'Excluir arquivo', 'Uploading…': 'Enviando…', '1 selected · {{name}}': '1 selecionado · {{name}}',
    'Select at least one file to upload.': 'Selecione pelo menos um arquivo para enviar.', '{{count}} file(s) uploaded successfully.': '{{count}} arquivo(s) enviado(s) com sucesso.', 'File not found': 'Arquivo não encontrado', 'The requested file does not exist.': 'O arquivo solicitado não existe.', 'File data missing': 'Dados do arquivo ausentes', 'The file record exists, but its data could not be found on disk.': 'O registro existe, mas os dados não foram encontrados no disco.', 'The file to delete could not be found.': 'O arquivo a ser excluído não foi encontrado.', '{{name}} was deleted.': '{{name}} foi excluído.', 'Deleted the {{name}} repository and its files.': 'O repositório {{name}} e seus arquivos foram excluídos.',
    'LANGUAGE AND REGION': 'IDIOMA E REGIÃO', 'Language settings': 'Configurações de idioma', 'Choose the language used across RecordDrive. The default follows your browser language.': 'Escolha o idioma usado no RecordDrive. Por padrão, ele segue o idioma do navegador.', 'Language preference': 'Preferência de idioma', 'Use browser language': 'Usar idioma do navegador', 'Browser language': 'Idioma do navegador', 'Saved preference': 'Preferência salva', 'Current source': 'Origem atual', 'Save language': 'Salvar idioma', 'Your selection is stored in this browser and remains available after signing out.': 'Sua seleção fica salva neste navegador e permanece disponível após sair.', 'Language preference updated.': 'A preferência de idioma foi atualizada.', 'The selected language is not supported.': 'O idioma selecionado não é compatível.',
    'Page not found': 'Página não encontrada', 'The requested page does not exist or has been moved.': 'A página solicitada não existe ou foi movida.', 'Upload failed': 'Falha no envio', 'An error occurred while uploading the file.': 'Ocorreu um erro ao enviar o arquivo.', 'Each file can be up to {{size}} MB.': 'Cada arquivo pode ter até {{size}} MB.', 'You can upload up to {{count}} files at a time.': 'Você pode enviar até {{count}} arquivos por vez.', 'Server error': 'Erro do servidor', 'An error occurred while processing the request.': 'Ocorreu um erro ao processar a solicitação.', 'Access denied': 'Acesso negado', 'Only administrators can access this page.': 'Somente administradores podem acessar esta página.', 'Only regular users can create personal repositories.': 'Somente usuários comuns podem criar repositórios pessoais.', 'Request could not be verified': 'Não foi possível verificar a solicitação', 'The security token is invalid or has expired. Refresh the page and try again.': 'O token de segurança é inválido ou expirou. Atualize a página e tente novamente.', 'RECORDDRIVE ERROR': 'ERRO DO RECORDDRIVE', 'Go to My Drive': 'Ir para Meu Drive', 'Go to sign in': 'Ir para o login'
  }
};

for (const source of [
  extendedTranslations,
  securityTranslations,
  previewTranslations,
  repositorySettingsTranslations
]) {
  for (const [language, entries] of Object.entries(source)) {
    Object.assign(translations[language], entries);
  }
}

export function normalizeLanguage(value) {
  const primary = String(value || '').trim().toLowerCase().split(/[-_]/)[0];
  return SUPPORTED_CODES.has(primary) ? primary : null;
}

function parseCookieHeader(header = '') {
  const cookies = {};
  for (const part of String(header).split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    if (!key) continue;
    try {
      cookies[key] = decodeURIComponent(rawValue);
    } catch {
      cookies[key] = rawValue;
    }
  }
  return cookies;
}

export function detectBrowserLanguage(req) {
  const accepted = String(req.get?.('accept-language') || req.headers?.['accept-language'] || '');
  const candidates = accepted
    .split(',')
    .map((entry, index) => {
      const [tag, ...parameters] = entry.trim().split(';');
      let quality = 1;
      for (const parameter of parameters) {
        const match = parameter.trim().match(/^q=([0-9.]+)$/i);
        if (match) quality = Number.parseFloat(match[1]);
      }
      return { language: normalizeLanguage(tag), quality: Number.isFinite(quality) ? quality : 0, index };
    })
    .filter(({ language, quality }) => language && quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  return candidates[0]?.language || DEFAULT_LANGUAGE;
}

export function createTranslator(language) {
  const selectedLanguage = normalizeLanguage(language) || DEFAULT_LANGUAGE;
  return (key, values = {}) => {
    const template = translations[selectedLanguage]?.[key] ?? key;
    return String(template).replace(/\{\{(\w+)\}\}/g, (match, name) => {
      return Object.hasOwn(values, name) ? String(values[name]) : match;
    });
  };
}

export function languageMiddleware(req, res, next) {
  const cookies = parseCookieHeader(req.headers.cookie);
  const savedLanguage = normalizeLanguage(cookies[LANGUAGE_COOKIE]);
  const browserLanguage = detectBrowserLanguage(req);
  const language = savedLanguage || browserLanguage;
  const t = createTranslator(language);

  req.language = language;
  req.browserLanguage = browserLanguage;
  req.languageMode = savedLanguage ? 'saved' : 'auto';
  req.t = t;

  res.locals.language = language;
  res.locals.browserLanguage = browserLanguage;
  res.locals.languageMode = req.languageMode;
  res.locals.supportedLanguages = SUPPORTED_LANGUAGES;
  res.locals.t = t;
  res.set('Content-Language', language);
  res.vary('Accept-Language');
  res.vary('Cookie');
  next();
}

export function saveLanguagePreference(req, res, language) {
  const normalized = normalizeLanguage(language);
  if (!normalized) return false;
  res.cookie(LANGUAGE_COOKIE, normalized, {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure,
    maxAge: LANGUAGE_COOKIE_MAX_AGE,
    path: '/'
  });
  return true;
}

export function clearLanguagePreference(req, res) {
  res.clearCookie(LANGUAGE_COOKIE, {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure,
    path: '/'
  });
}
