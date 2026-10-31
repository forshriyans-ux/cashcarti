// Framework-independent adapter. Import these methods into the existing frontend without changing its layout.
import type {
  ProjectInput,
  ReviewStage,
  Project,
  UploadedDocument,
  ReviewRun,
  Finding,
  Collection,
  ReviewReport,
} from './api-types.js';
export class PermitProofClient {
  constructor(
    private baseUrl: string,
    private token: () => Promise<string>,
    private organizationId: string,
  ) {}
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${await this.token()}`);
    headers.set('X-Organization-Id', this.organizationId);
    if (init.body && !(init.body instanceof FormData))
      headers.set('Content-Type', 'application/json');
    const response = await fetch(this.baseUrl + path, { ...init, headers });
    if (!response.ok) {
      const b = await response.json();
      throw Object.assign(new Error(b.error.message), {
        code: b.error.code,
        status: response.status,
      });
    }
    if (path.endsWith('.pdf') || path.endsWith('/download')) return (await response.blob()) as T;
    return response.json() as Promise<T>;
  }
  createProject(input: ProjectInput) {
    return this.request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(input) });
  }
  listProjects() {
    return this.request<Collection<Project>>('/api/projects');
  }
  upload(projectId: string, file: File) {
    const data = new FormData();
    data.set('file', file);
    return this.request<{ document: UploadedDocument; duplicate: boolean }>(
      `/api/projects/${encodeURIComponent(projectId)}/documents`,
      { method: 'POST', body: data },
    );
  }
  documents(projectId: string) {
    return this.request<Collection<UploadedDocument>>(
      `/api/projects/${encodeURIComponent(projectId)}/documents`,
    );
  }
  startReview(projectId: string) {
    return this.request<{ review: { id: string; status: string; stage: ReviewStage } }>(
      `/api/projects/${encodeURIComponent(projectId)}/reviews`,
      { method: 'POST' },
    );
  }
  review(id: string) {
    return this.request<ReviewRun>(`/api/reviews/${encodeURIComponent(id)}`);
  }
  findings(id: string) {
    return this.request<Collection<Finding>>(`/api/reviews/${encodeURIComponent(id)}/findings`);
  }
  report(id: string) {
    return this.request<ReviewReport>(`/api/reviews/${encodeURIComponent(id)}/report`);
  }
  reportPDF(id: string) {
    return this.request<Blob>(`/api/reviews/${encodeURIComponent(id)}/report.pdf`);
  }
}
