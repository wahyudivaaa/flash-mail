import { browser } from '$app/environment';
import type { SweetAlertIcon, SweetAlertOptions } from 'sweetalert2';

type SweetAlertModule = typeof import('sweetalert2').default;
type AlertTone = 'danger' | 'info' | 'question' | 'success' | 'warning';

export interface ConfirmDialogOptions {
  title: string;
  text?: string;
  html?: string;
  icon?: SweetAlertIcon;
  eyebrow?: string;
  detailLabel?: string;
  detailValue?: string;
  note?: string;
  confirmButtonText: string;
  cancelButtonText: string;
  danger?: boolean;
}

export interface ToastOptions {
  title: string;
  text?: string;
  icon?: SweetAlertIcon;
  timer?: number;
}

let sweetAlertPromise: Promise<SweetAlertModule> | null = null;

async function getSweetAlert(): Promise<SweetAlertModule | null> {
  if (!browser) {
    return null;
  }

  sweetAlertPromise ??= import('sweetalert2').then((module) => module.default);
  return sweetAlertPromise;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getTone(icon: SweetAlertIcon | undefined, danger = false): AlertTone {
  if (danger || icon === 'error') return 'danger';
  if (icon === 'success') return 'success';
  if (icon === 'warning') return 'warning';
  if (icon === 'question') return 'question';
  return 'info';
}

function renderIconHtml(tone: AlertTone): string {
  const iconByTone: Record<AlertTone, string> = {
    danger: 'delete_forever',
    info: 'notifications_active',
    question: 'help',
    success: 'check_circle',
    warning: 'report'
  };

  return `<span class="material-symbols-outlined mailflare-swal-icon-symbol" aria-hidden="true">${iconByTone[tone]}</span>`;
}

function renderDialogHtml(options: ConfirmDialogOptions, tone: AlertTone): string {
  const eyebrow = escapeHtml(options.eyebrow ?? 'Flash Mail Flare');
  const content = options.html
    ? `<div class="mailflare-swal-message mailflare-swal-message-html">${options.html}</div>`
    : options.text
      ? `<p class="mailflare-swal-message">${escapeHtml(options.text)}</p>`
      : '';
  const detail =
    options.detailValue && options.detailLabel
      ? `<div class="mailflare-swal-detail">
          <span>${escapeHtml(options.detailLabel)}</span>
          <strong>${escapeHtml(options.detailValue)}</strong>
        </div>`
      : '';
  const note = options.note
    ? `<div class="mailflare-swal-note">
        <span class="material-symbols-outlined" aria-hidden="true">shield_lock</span>
        <span>${escapeHtml(options.note)}</span>
      </div>`
    : '';

  return `<div class="mailflare-swal-content mailflare-swal-content-${tone}">
    <span class="mailflare-swal-eyebrow">${eyebrow}</span>
    ${content}
    ${detail}
    ${note}
  </div>`;
}

function renderToastHtml(text?: string): string | undefined {
  if (!text) {
    return undefined;
  }

  return `<div class="mailflare-swal-toast-copy">${escapeHtml(text)}</div>`;
}

function buildButtonClasses(tone: AlertTone, danger: boolean): SweetAlertOptions['customClass'] {
  return {
    container: 'mailflare-swal-container',
    popup: `mailflare-swal-popup mailflare-swal-popup-${tone}`,
    icon: `mailflare-swal-icon mailflare-swal-icon-${tone}`,
    title: 'mailflare-swal-title',
    htmlContainer: 'mailflare-swal-body',
    actions: 'mailflare-swal-actions',
    closeButton: 'mailflare-swal-close',
    confirmButton: `mailflare-swal-button mailflare-swal-confirm ${danger ? 'mailflare-swal-confirm-danger' : ''}`,
    cancelButton: 'mailflare-swal-button mailflare-swal-cancel'
  };
}

export async function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  const Swal = await getSweetAlert();
  if (!Swal) {
    return false;
  }

  const icon = options.icon ?? (options.danger ? 'warning' : 'question');
  const tone = getTone(icon, options.danger);
  const result = await Swal.fire({
    title: options.title,
    html: renderDialogHtml(options, tone),
    icon,
    iconHtml: renderIconHtml(tone),
    showCancelButton: true,
    showCloseButton: true,
    confirmButtonText: options.confirmButtonText,
    cancelButtonText: options.cancelButtonText,
    reverseButtons: true,
    focusCancel: true,
    buttonsStyling: false,
    allowOutsideClick: true,
    heightAuto: false,
    backdrop: 'rgba(7, 13, 27, 0.58)',
    width: 'min(92vw, 34rem)',
    showClass: {
      popup: 'mailflare-swal-show'
    },
    hideClass: {
      popup: 'mailflare-swal-hide'
    },
    customClass: buildButtonClasses(tone, Boolean(options.danger))
  });

  return result.isConfirmed;
}

export async function toast(options: ToastOptions): Promise<void> {
  const Swal = await getSweetAlert();
  if (!Swal) {
    return;
  }

  const icon = options.icon ?? 'info';
  const tone = getTone(icon);
  const toastSwal = Swal.mixin({
    toast: true,
    position: 'bottom-end',
    showConfirmButton: false,
    timer: options.timer ?? 3600,
    timerProgressBar: false,
    width: 'min(24rem, calc(100vw - 2rem))',
    showClass: {
      popup: 'mailflare-toast-show'
    },
    hideClass: {
      popup: 'mailflare-toast-hide'
    },
    customClass: {
      container: 'mailflare-toast-container',
      popup: `mailflare-swal-toast mailflare-swal-toast-${tone}`,
      icon: `mailflare-swal-toast-icon mailflare-swal-toast-icon-${tone}`,
      title: 'mailflare-swal-toast-title',
      htmlContainer: 'mailflare-swal-toast-body',
      timerProgressBar: 'mailflare-swal-toast-progress'
    }
  });

  await toastSwal.fire({
    icon,
    iconHtml: renderIconHtml(tone),
    title: options.title,
    html: renderToastHtml(options.text)
  });
}

export function successToast(title: string, text?: string): Promise<void> {
  return toast({ icon: 'success', title, text });
}

export function warningToast(title: string, text?: string): Promise<void> {
  return toast({ icon: 'warning', title, text, timer: 5200 });
}

export function errorToast(title: string, text?: string): Promise<void> {
  return toast({ icon: 'error', title, text, timer: 5600 });
}
