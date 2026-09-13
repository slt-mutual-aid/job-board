import type { Job } from "../lib/db";

interface JobModalProps {
  job: Job | null;
  onClose: () => void;
}

// Sentinel date for unknown posted dates (epoch: 1970-01-01T00:00:00.000Z)
const UNKNOWN_DATE_STRING = new Date(0).toISOString();
function isUnknownDate(dateStr: string): boolean {
  return dateStr === UNKNOWN_DATE_STRING;
}

export default function JobModal({ job, onClose }: JobModalProps) {
  if (!job) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <button
          className="modal-close"
          onClick={onClose}
          aria-label="Close modal"
        >
          ×
        </button>
        <h2>{job.title}</h2>
        <div className="job-details-header">
          <p className="company">{job.company}</p>
          <span className="separator">-</span>
          <p className="location">{job.location}</p>
        </div>
        {job.hourly_rate && (
          <p className="hourly-rate">
            <strong>Hourly Rate:</strong> {job.hourly_rate}
          </p>
        )}
        {job.job_type && (
          <p className="job-type-detail">
            <strong>Type:</strong> {job.job_type}
          </p>
        )}
        {/* posted_date holds a calendar date stored at UTC midnight, so format it in UTC rather than the viewer timezone. */}
        <p className="posted-date">
          <strong>Posted:</strong>{" "}
          {isUnknownDate(job.posted_date)
            ? "Unknown"
            : new Date(job.posted_date).toLocaleDateString(undefined, {
                timeZone: "UTC",
              })}
        </p>
        <div className="job-description">
          <h3>Description</h3>
          <p>{job.description}</p>
        </div>
        {job.apply_link ? (
          <a
            href={job.apply_link}
            target="_blank"
            rel="noopener noreferrer"
            className="apply-button"
          >
            Apply Now
          </a>
        ) : job.application_instructions ? (
          <div className="application-instructions">
            <h3>Application Instructions</h3>
            <p>{job.application_instructions}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
