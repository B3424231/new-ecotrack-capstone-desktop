/**
 * EcoTrack - Maintenance Management Controller
 * Dynamically linked to live Supabase nodes, rooms, and real maintenance records.
 * Handles Create Report Modal, Report Details Modal with full Light & Dark theme support,
 * AC Device Diagnostics, Task Checklists, Progress Tracking, and Verification.
 */

(function () {
  // ===================================================================
  // 1. SUPABASE DATA LAYER & STORE
  // ===================================================================

  function getSb() {
    return window.supabaseClient || window.sb;
  }
  let _reportsCache = [];
  const reportVersions = new Map();
  let reportWriteRevision = 0;
  const confirmedReportWrites = new Map();

  // Preserve legacy relative labels while rendering precise timestamps written
  // by the mobile app in a concise, consistent desktop format.
  function formatMaintenanceUpdateTime(value, fallback = 'Today') {
    if (!value) return fallback;
    const parsed = new Date(value);
    if (isNaN(parsed.getTime())) return String(value);
    return parsed.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function isActualRepairTask(r) {
    if (!r) return false;
    const idStr = String(r.id || '').trim().toUpperCase();
    if (idStr.startsWith('REP-') || idStr.startsWith('RWK-')) return true;
    // Parent references identify children; linkedRepairId points down from a maintenance report.
    if ([r.parentReportId, r.parent_report_id, r.linkedParentId].some(id => String(id || '').trim())) return true;
    const typeStr = String(r.type || '').trim().toLowerCase();
    if (['preventive', 'cleaning', 'routine', 'calibration', 'inspection'].some(type => typeStr.includes(type))) return false;
    return typeStr.includes('corrective') || typeStr.includes('repair');
  }

  function isComponentInIssue(componentName, issue) {
    if (!issue || !componentName) return false;
    const target = String(componentName).toLowerCase().trim();
    if (Array.isArray(issue.components)) {
      if (issue.components.some(c => String(c).toLowerCase().trim() === target)) return true;
    }
    if (issue.component) {
      const raw = String(issue.component).toLowerCase().trim();
      if (raw === target) return true;
      const parts = raw.split(/[,•|;/]+/).map(p => p.trim());
      if (parts.includes(target)) return true;
      if (parts.some(p => p && (target.includes(p) || p.includes(target)))) return true;
    }
    return false;
  }

  function isMockOrTestReport(r) {
    if (!r) return false;
    const id = String(typeof r === 'string' ? r : (r.id || '')).trim().toUpperCase();
    return id.includes('-TEST-') || id.startsWith('TEST-') || id.endsWith('-TEST') || id.includes('TEST_') || id.includes('MOCK');
  }

  function normalizeReport(r) {
    if (!r) return null;
    let rawTasks = [];
    if (Array.isArray(r.tasks)) {
      rawTasks = r.tasks;
    } else if (typeof r.tasks === 'string' && r.tasks.trim().length > 0) {
      try {
        const parsed = JSON.parse(r.tasks);
        if (Array.isArray(parsed)) rawTasks = parsed;
      } catch (e) {
        console.warn('[normalizeReport] Failed to parse r.tasks JSON string:', e);
      }
    }
    if (rawTasks.length === 0) {
      rawTasks = [
        { id: 1, name: 'Aircon Cleaning', status: 'Not Started', notes: '', updated: 'Today' },
        { id: 2, name: 'Filter Cleaning', status: 'Not Started', notes: '', updated: 'Today' },
        { id: 3, name: 'Temperature Control Inspection', status: 'Not Started', notes: '', updated: 'Today' },
        { id: 4, name: 'Air Pressure Control Inspection', status: 'Not Started', notes: '', updated: 'Today' },
        { id: 5, name: 'Energy Control Inspection', status: 'Not Started', notes: '', updated: 'Today' }
      ];
    }
    const tasks = rawTasks.map((t, idx) => {
      let taskPhotoUris = [];
      if (Array.isArray(t.photoUris)) {
        taskPhotoUris = t.photoUris.filter(Boolean);
      } else if (typeof t.photoUris === 'string' && t.photoUris.trim().startsWith('[')) {
        try { taskPhotoUris = JSON.parse(t.photoUris).filter(Boolean); } catch (e) { }
      } else if (Array.isArray(t.photos)) {
        taskPhotoUris = t.photos.filter(Boolean);
      } else if (typeof t.photos === 'string' && t.photos.trim().startsWith('[')) {
        try { taskPhotoUris = JSON.parse(t.photos).filter(Boolean); } catch (e) { }
      }
      const taskPhoto = t.photo || t.photoUri || t.photo_uri || t.photoUrl || t.photo_url || t.image || t.imageUrl || t.image_url || t.attachment || t.uri || (taskPhotoUris.length > 0 ? taskPhotoUris[0] : null);
      if (taskPhoto && taskPhotoUris.length === 0) {
        taskPhotoUris = [taskPhoto];
      } else if (taskPhoto && !taskPhotoUris.includes(taskPhoto)) {
        taskPhotoUris.unshift(taskPhoto);
      }

      // A "Not Started" task cannot have a worker completion photo.
      // Also prevent accidental inheritance of parent defect photo.
      const isNotStarted = (t.status || 'Not Started') === 'Not Started';
      const isRepairOrder = isActualRepairTask(r);
      const isParentDefectPhoto = Boolean(
        (r.photo_url && taskPhoto === r.photo_url) ||
        (r.issue && (taskPhoto === r.issue.photo || taskPhoto === r.issue.photoUri))
      );
      const stripPhoto = isNotStarted && (isRepairOrder || isParentDefectPhoto || !t.verified);
      const finalPhoto = stripPhoto ? null : taskPhoto;
      const finalPhotoUris = stripPhoto ? [] : taskPhotoUris;

      const taskNotes = t.notes || t.remarks || t.problemDescription || t.comment || (typeof t.description === 'string' && t.description !== t.name ? t.description : '') || '';
      return {
        ...t,
        id: (t.id !== undefined && t.id !== null && t.id !== '') ? t.id : (idx + 1),
        name: t.name || t.title || `Task #${idx + 1}`,
        status: t.status || 'Not Started',
        notes: taskNotes,
        photo: finalPhoto,
        photoUri: finalPhoto,
        photoUris: finalPhotoUris,
        photos: finalPhotoUris,
        verified: Boolean(t.verified),
        repaired: Boolean(t.repaired),
        linkedRepairId: t.linkedRepairId || t.repairId || null,
        updated: formatMaintenanceUpdateTime(t.updated || t.updated_at || t.updatedAt || r.updated, 'Today'),
        updatedAt: t.updatedAt || t.updated_at || t.updated || r.updated || null
      };
    });
    let status = r.status || 'Pending';
    if (['pending verification', 'awaiting admin verification'].includes(String(status).toLowerCase())) status = 'For Verification';
    let issue = r.issue || null;
    if (issue) {
      if (typeof issue === 'string') {
        try { issue = JSON.parse(issue); } catch (e) { }
      }
      if (issue && typeof issue === 'object') {
        let issuePhotoUris = [];
        if (Array.isArray(issue.photoUris)) {
          issuePhotoUris = issue.photoUris.filter(Boolean);
        } else if (typeof issue.photoUris === 'string' && issue.photoUris.trim().startsWith('[')) {
          try { issuePhotoUris = JSON.parse(issue.photoUris).filter(Boolean); } catch (e) { }
        } else if (Array.isArray(issue.photos)) {
          issuePhotoUris = issue.photos.filter(Boolean);
        }
        const issuePhoto = issue.photoUri || issue.photo || issue.photo_url || issue.photoUrl || issue.image || issue.imageUrl || (issuePhotoUris.length > 0 ? issuePhotoUris[0] : null);
        if (issuePhoto && issuePhotoUris.length === 0) {
          issuePhotoUris = [issuePhoto];
        } else if (issuePhoto && !issuePhotoUris.includes(issuePhoto)) {
          issuePhotoUris.unshift(issuePhoto);
        }
        issue.photo = issuePhoto;
        issue.photoUri = issuePhoto;
        issue.photoUris = issuePhotoUris;
        issue.photos = issuePhotoUris;
      }
    }
    const isIssueRepaired = Boolean(issue && (issue.repaired || issue.status === 'Repaired' || issue.isRepaired));

    const isReworkStatus = status === 'Need Rework' || status === 'Needs Rework';
    const isClosedStatus = status === 'Closed';
    const allTasksCompleted = tasks.length > 0 && tasks.every(t => t.status === 'Completed' || t.repaired);
    const hasRepairTask = !allTasksCompleted && tasks.some(t => t.status === 'Needs Repair' && !t.repaired);
    const hasUnderRepairTask = !allTasksCompleted && tasks.some(t => t.status === 'Under Repair' && !t.repaired);
    const isExplicitlyVerified = (status === 'Verified' || r.verified) && allTasksCompleted && tasks.every(t => t.verified || t.status === 'Completed');

    // Synchronize defect/issue with checklist tasks ONLY IF report is actively in defect/repair state
    // and NOT when actively undergoing rework, verified, closed, or already repaired/all completed
    const isRepTask = isActualRepairTask(r);
    if (!isRepTask && !isReworkStatus && !isClosedStatus && !isExplicitlyVerified && !isIssueRepaired && !allTasksCompleted && issue && tasks.length > 0) {
      const isMultiComponentIssue = (Array.isArray(issue.components) && issue.components.length > 1) ||
        (typeof issue.component === 'string' && issue.component.split(/[,;/]+/).filter(Boolean).length > 1);

      tasks.forEach(t => {
        if (isComponentInIssue(t.name, issue) && t.status !== 'Completed' && !t.repaired) {
          // Strict per-task isolation: a task is ONLY 'Under Repair' if it specifically has its own
          // linked repair ID (or for single-component issues, if it was explicitly marked Under Repair).
          // Undispatched defects MUST strictly remain 'Needs Repair'!
          const hasOwnRepair = Boolean(t.linkedRepairId && !t.repaired);
          if (hasOwnRepair || (t.status === 'Under Repair' && !isMultiComponentIssue)) {
            t.status = 'Under Repair';
          } else {
            t.status = 'Needs Repair';
          }
          if (issue.notes && !t.notes) t.notes = issue.notes;

          const hasOwnPhotos = (Array.isArray(t.photoUris) && t.photoUris.length > 0) ||
            (Array.isArray(t.photos) && t.photos.length > 0) ||
            Boolean(t.photo && t.photo !== issue.photoUri && t.photo !== issue.photo);

          // ONLY inherit issue photos if this task has NO photos of its own AND the issue is for this single component
          if (!hasOwnPhotos && !isMultiComponentIssue) {
            const issuePhoto = issue.photoUri || issue.photo || issue.photo_url || issue.photoUrl || issue.image || issue.imageUrl;
            if (issuePhoto && !t.photo) {
              t.photo = issuePhoto;
              t.photoUri = issuePhoto;
            }
            if (Array.isArray(issue.photoUris) && issue.photoUris.length > 0) {
              t.photoUris = [...issue.photoUris];
              t.photos = t.photoUris;
            }
          }
        }
      });
    }

    if (isClosedStatus) {
      status = 'Closed';
    } else if (isExplicitlyVerified || (allTasksCompleted && (r.verified || status === 'Verified' || status === 'Completed'))) {
      status = 'Completed';
      tasks.forEach(t => { if (t.status === 'Completed' || t.repaired) t.verified = true; });
    } else if (status === 'Completed' || status === 'Verified') {
      // A report cannot become Completed while its own required tasks are unfinished!
      if (allTasksCompleted) {
        status = 'Completed';
      } else {
        status = isRepTask ? 'In Progress' : (hasRepairTask ? 'Needs Repair' : (hasUnderRepairTask ? 'Under Repair' : 'In Progress'));
      }
    } else if (isReworkStatus) {
      status = 'Need Rework';
    } else if (allTasksCompleted || status === 'For Verification' || status === 'Awaiting Admin Verification') {
      // 100% completed checklist tasks automatically transition to For Verification (Awaiting Admin Verification)!
      status = 'For Verification';
    } else if (isRepTask) {
      // Corrective repair order status: if tasks are not all completed, status is In Progress (never Under Repair or Completed)
      status = 'In Progress';
    } else if (hasRepairTask || (issue && !isIssueRepaired && !hasUnderRepairTask)) {
      status = 'Needs Repair';
      if (!issue && hasRepairTask) {
        const repTasks = tasks.filter(t => t.status === 'Needs Repair' && !t.repaired);
        if (repTasks.length > 0) {
          issue = {
            component: repTasks.map(t => t.name).join(', '),
            components: repTasks.map(t => t.name),
            notes: repTasks.length === 1 ? (repTasks[0].notes || 'Maintenance defect requires repair.') : repTasks.map(t => `${t.name}: ${t.notes || 'Defect reported'}`).join(' • ')
          };
        }
      }
    } else if (hasUnderRepairTask) {
      status = 'Under Repair';
    } else if (tasks.some(t => t.status === 'In Progress')) {
      status = 'In Progress';
    }

    // Deduplicate timeline entries:
    // 1) Remove consecutive exact-duplicate titles (same title in a row).
    // 2) Keep only the latest entry for any title that appears more than once
    //    within the same batch of consecutive identical entries.
    const rawTimeline = Array.isArray(r.timeline) ? r.timeline : [];
    const dedupedTimeline = rawTimeline.filter((entry, idx, arr) => {
      if (!entry || typeof entry.title !== 'string') return false;
      // Remove if the previous entry has the exact same title
      if (idx > 0 && arr[idx - 1]?.title === entry.title) return false;
      return true;
    });

    let reportCreated = r.created || r.created_at || r.createdAt;
    if (!reportCreated) {
      if (r.created_date && !isNaN(new Date(r.created_date).getTime())) {
        reportCreated = new Date(r.created_date).toISOString();
      } else if (r.createdDate && !isNaN(new Date(r.createdDate).getTime())) {
        reportCreated = new Date(r.createdDate).toISOString();
      } else {
        reportCreated = new Date().toISOString();
      }
    }

    let repPhotos = [];
    if (Array.isArray(r.photos) && r.photos.length > 0) {
      repPhotos = r.photos.filter(Boolean);
    } else if (typeof r.photos === 'string' && r.photos.trim().startsWith('[')) {
      try { repPhotos = JSON.parse(r.photos).filter(Boolean); } catch (_) {}
    } else if (Array.isArray(r.photoUris) && r.photoUris.length > 0) {
      repPhotos = r.photoUris.filter(Boolean);
    } else if (typeof r.photoUris === 'string' && r.photoUris.trim().startsWith('[')) {
      try { repPhotos = JSON.parse(r.photoUris).filter(Boolean); } catch (_) {}
    }

    // Inherit issue / defect evidence photos if report photos are empty or fewer than issue photos
    if (issue) {
      const issuePhotosList = (Array.isArray(issue.photos) && issue.photos.length > 0)
        ? issue.photos.filter(Boolean)
        : ((Array.isArray(issue.photoUris) && issue.photoUris.length > 0) ? issue.photoUris.filter(Boolean) : []);
      if (issuePhotosList.length > repPhotos.length) {
        repPhotos = issuePhotosList;
      }
    }

    const repPhoto = repPhotos.length > 0
      ? repPhotos[0]
      : (r.photo_url || r.photoUrl || (issue && (issue.photoUri || issue.photo)) || null);

    if (repPhotos.length === 0 && repPhoto) {
      repPhotos = [repPhoto];
    }

    return {
      id: r.id,
      airconId: r.aircon_name || r.aircon_id || r.airconId || 'AC-Unassigned',
      aircon_id: r.aircon_id,
      node_id: r.node_id || r.nodeId || r.controller_node_id || null,
      controller_name: r.controller_name || r.controllerName || '',
      room_id: r.room_id || r.roomId || null,
      aircon_name: r.aircon_name || r.airconId,
      airconType: r.aircon_type || r.airconType || 'Type unavailable',
      aircon_type: r.aircon_type || r.airconType || 'Type unavailable',
      room: r.room_name || r.room || 'Main Campus',
      room_name: r.room_name || r.room,
      type: r.type || 'Preventive Maintenance',
      priority: r.priority || 'Medium',
      staffName: r.staff_name || r.staffName || 'Unassigned',
      staff_name: r.staff_name || r.staffName,
      staff_id: r.staff_id,
      dueDate: r.due_date || r.dueDate || '',
      due_date: r.due_date || r.dueDate,
      createdDate: r.created_date || r.createdDate || (reportCreated ? new Date(reportCreated).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Today'),
      created_date: r.created_date || r.createdDate,
      status: status,
      description: r.description || '',
      tasks: tasks,
      issue: issue,
      photo_url: repPhoto,
      photoUrl: repPhoto,
      photos: repPhotos,
      photoUris: repPhotos,
      linkedRepairId: r.linked_repair_id || r.linkedRepairId || r.repair_id || r.repairReportId || null,
      linked_repair_id: r.linked_repair_id || r.linkedRepairId || r.repair_id || r.repairReportId || null,
      parentReportId: r.parent_report_id || r.parentReportId || r.linkedParentId || null,
      parent_report_id: r.parent_report_id || r.parentReportId || r.linkedParentId || null,
      parentTaskId: (r.parent_task_id !== undefined && r.parent_task_id !== null) ? r.parent_task_id : ((r.parentTaskId !== undefined && r.parentTaskId !== null) ? r.parentTaskId : null),
      parent_task_id: (r.parent_task_id !== undefined && r.parent_task_id !== null) ? r.parent_task_id : ((r.parentTaskId !== undefined && r.parentTaskId !== null) ? r.parentTaskId : null),
      parentTaskName: r.parent_task_name || r.parentTaskName || null,
      parent_task_name: r.parent_task_name || r.parentTaskName || null,
      linkedRepairIds: Array.isArray(r.linkedRepairIds) ? r.linkedRepairIds : (Array.isArray(r.linked_repair_ids) ? r.linked_repair_ids : []),
      verificationRemarks: r.verification_remarks || r.verificationRemarks || '',
      verification_remarks: r.verification_remarks || r.verificationRemarks || '',
      timeline: dedupedTimeline,
      created: reportCreated,
      updated: r.updated || r.updated_at || r.updatedAt || reportCreated,
      updated_at: r.updated_at || r.updated || r.updatedAt || reportCreated
    };
  }

  function deduplicateReports(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const result = [];
    for (const r of list) {
      if (!r) continue;
      const rawId = r.id || (r.airconId ? `${r.airconId}_${r.type || 'maint'}` : null);
      if (!rawId) continue;
      const idKey = String(rawId).trim().toUpperCase();
      if (!seen.has(idKey)) {
        seen.add(idKey);
        result.push(r);
      }
    }
    return result;
  }

  // Safe timeline unshift: only adds the entry if the most recent entry doesn't already have the same title.
  // Prevents duplicate consecutive timeline events when the same action is triggered multiple times.
  function safeTimelineUnshift(timeline, entry) {
    if (!Array.isArray(timeline)) return;
    const topEntry = timeline[0];
    if (topEntry && topEntry.title === entry.title) return; // already the latest entry
    timeline.unshift(entry);
  }

  function findReportById(reports, id) {
    if (id === undefined || id === null || id === '') return null;
    const list = Array.isArray(reports) ? reports : getReports();
    return list.find(r =>
      String(r.id) === String(id) ||
      r.id == id ||
      (r.airconId && String(r.airconId).toLowerCase() === String(id).toLowerCase())
    ) || null;
  }

  function generateNextReportId(reports) {
    let maxNum = 0;
    const list = Array.isArray(reports) ? reports : getReports();
    list.forEach(r => {
      if (!r || !r.id) return;
      const m = String(r.id).match(/MR-\d{4}-(\d+)/i);
      if (m) {
        const n = parseInt(m[1], 10);
        if (!isNaN(n) && n > maxNum) maxNum = n;
      }
    });
    const nextNum = maxNum > 0 ? (maxNum + 1) : 1;
    return `MR-2026-${String(nextNum).padStart(3, '0')}`;
  }

  // Helper to locate all child Corrective Repair reports connected to a parent report
  function getChildRepairReportsFor(report, reports) {
    if (!report) return [];
    const isRepReport = isActualRepairTask(report);
    if (isRepReport) return []; // A Corrective Repair report cannot have child repair reports
    const allReports = Array.isArray(reports) ? reports : getReports();
    const rId = String(report.id || '').trim().toLowerCase();

    const children = allReports.filter(r => {
      if (!r || r.id === report.id) return false;
      const isCorrective = isActualRepairTask(r);
      if (!isCorrective) return false;

      // 1. Explicit parentReportId pointing to this report
      const pId = String(r.parentReportId || r.parent_report_id || r.linkedParentId || '').trim().toLowerCase();
      if (pId && pId === rId) return true;

      // 2. Any checklist task in report explicitly references this child repair order ID
      if (Array.isArray(report.tasks) && report.tasks.some(t => t.linkedRepairId && String(t.linkedRepairId).trim().toLowerCase() === String(r.id).trim().toLowerCase())) {
        return true;
      }

      // 3. Parent report lists this ID in linkedRepairIds or linkedRepairId
      if (Array.isArray(report.linkedRepairIds) && report.linkedRepairIds.some(lid => String(lid).trim().toLowerCase() === String(r.id).trim().toLowerCase())) {
        return true;
      }
      if (report.linkedRepairId && String(report.linkedRepairId).trim().toLowerCase() === String(r.id).trim().toLowerCase()) {
        return true;
      }

      return false;
    });

    return deduplicateReports(children);
  }

  // Helper to locate the exact child Corrective Repair report for a specific checklist task
  function getRepairReportForTask(report, task, reports) {
    if (!report || !task) return null;
    const childRepairs = getChildRepairReportsFor(report, reports);
    if (childRepairs.length === 0) return null;

    // 1. Direct task.linkedRepairId match
    if (task.linkedRepairId) {
      const found = childRepairs.find(cr => String(cr.id || '').trim().toLowerCase() === String(task.linkedRepairId).trim().toLowerCase());
      if (found) return found;
    }

    // 2. Direct parentTaskId match on child repair report
    if (task.id !== undefined && task.id !== null) {
      const found = childRepairs.find(cr => (cr.parentTaskId !== undefined && cr.parentTaskId !== null && String(cr.parentTaskId) === String(task.id)) ||
        (cr.parent_task_id !== undefined && cr.parent_task_id !== null && String(cr.parent_task_id) === String(task.id)) ||
        (cr.issue?.parentTaskId !== undefined && cr.issue?.parentTaskId !== null && String(cr.issue.parentTaskId) === String(task.id)));
      if (found) return found;
    }

    // 3. Match by task name vs parentTaskName or issue.component (exact match first)
    const tName = String(task.name || '').trim().toLowerCase();
    if (tName) {
      const foundExact = childRepairs.find(cr => {
        const crTaskName = String(cr.parentTaskName || cr.parent_task_name || '').trim().toLowerCase();
        const crIssueComp = String(cr.issue?.component || '').trim().toLowerCase();
        return crTaskName === tName || crIssueComp === tName;
      });
      if (foundExact) return foundExact;

      // 4. Fallback: single-component issue match (never match if child issue has multiple comma-separated components)
      const found = childRepairs.find(cr => {
        const comp = String(cr.issue?.component || '').trim();
        if (comp.includes(',') || comp.includes(';') || comp.includes('•')) return false;
        return isComponentInIssue(tName, cr.issue);
      });
      if (found) return found;
    }

    return null;
  }

  // Backwards compatibility for single-child callers: returns the primary or first child repair report
  function getRepairReportFor(report, reports) {
    const list = getChildRepairReportsFor(report, reports);
    return list.length > 0 ? list[0] : null;
  }

  function isRepairReportDone(repairReport) {
    if (!repairReport) return false;
    const s = String(repairReport.status || '').trim().toLowerCase();
    if (s === 'verified' || s === 'completed' || s === 'for verification') return true;
    if (Array.isArray(repairReport.tasks) && repairReport.tasks.length > 0 && repairReport.tasks.every(t => t.status === 'Completed')) {
      return true;
    }
    return false;
  }

  function isRepairReportVerified(repairReport) {
    if (!repairReport) return false;
    const s = String(repairReport.status || '').trim().toLowerCase();
    if (s === 'verified') return true;
    if (Array.isArray(repairReport.tasks) && repairReport.tasks.length > 0 && repairReport.tasks.every(t => t.status === 'Completed' && t.verified)) {
      return true;
    }
    return false;
  }

  function resolvePhotoUrl(rawPhoto) {
    if (!rawPhoto) return '';
    if (typeof rawPhoto === 'object') {
      rawPhoto = rawPhoto.url || rawPhoto.uri || rawPhoto.publicUrl || rawPhoto.path || rawPhoto.src || '';
    }
    if (typeof rawPhoto !== 'string') return '';
    let trimmed = rawPhoto.trim();
    if (!trimmed || trimmed.toLowerCase() === 'null' || trimmed.toLowerCase() === 'undefined') return '';
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      trimmed = trimmed.slice(1, -1).trim();
    }
    if (trimmed.startsWith('storage://')) {
      const match = trimmed.match(/^storage:\/\/([^/]+)\/(.+)$/);
      if (!match || match[2].split('/').some(part => !part || part === '.' || part === '..')) return '';
      const bucket = match[1];
      const path = match[2];
      const sb = getSb();
      if (sb?.storage && typeof sb.storage.from === 'function') {
        const { data } = sb.storage.from(bucket).getPublicUrl(path) || {};
        if (data?.publicUrl) return data.publicUrl;
      }
      const base = window.SUPABASE_URL || 'https://ynopdmfhngooknybyahq.supabase.co';
      return `${base.replace(/\/+$/, '')}/storage/v1/object/public/${bucket}/${path}`;
    }
    if (trimmed.startsWith('data:') || trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('blob:')) {
      return trimmed;
    }
    const sb = getSb();
    if (sb && sb.storage && typeof sb.storage.from === 'function') {
      const parts = trimmed.split('/');
      if (parts.length > 1) {
        try {
          const { data } = sb.storage.from(parts[0]).getPublicUrl(parts.slice(1).join('/'));
          if (data && data.publicUrl) return data.publicUrl;
        } catch (_) { }
      }
      const candidateBuckets = ['photos', 'maintenance', 'images', 'attachments', 'proof', 'avatars'];
      for (const b of candidateBuckets) {
        try {
          const { data } = sb.storage.from(b).getPublicUrl(trimmed);
          if (data && data.publicUrl) return data.publicUrl;
        } catch (_) { }
      }
    }
    const base = window.SUPABASE_URL || 'https://ynopdmfhngooknybyahq.supabase.co';
    return `${base.replace(/\/+$/, '')}/storage/v1/object/public/photos/${trimmed}`;
  }
  window.EcoTrackResolvePhoto = resolvePhotoUrl;

  window.handlePhotoLoadError = function (img, idx) {
    if (!img) return;
    if (!img.dataset.retried) {
      img.dataset.retried = '1';
      const raw = img.getAttribute('data-raw') || img.src;
      const resolved = resolvePhotoUrl(raw);
      if (resolved && resolved !== img.src && !resolved.startsWith('storage://')) {
        img.src = resolved;
        return;
      }
    }
    img.onerror = null;
    if (img.parentElement) {
      img.parentElement.innerHTML = `
        <div class="w-full h-full flex flex-col items-center justify-center p-1 text-center bg-slate-900/80 text-rose-400 select-none">
          <svg class="w-4 h-4 opacity-75 mb-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
          <span class="text-[9px] font-bold truncate max-w-full">Photo ${idx || ''}</span>
        </div>`;
    }
  };

  window.handleCarouselPhotoError = function (img, idx) {
    if (!img) return;
    if (!img.dataset.retried) {
      img.dataset.retried = '1';
      const raw = img.getAttribute('data-raw') || img.src;
      const resolved = resolvePhotoUrl(raw);
      if (resolved && resolved !== img.src && !resolved.startsWith('storage://')) {
        img.src = resolved;
        return;
      }
    }
    img.onerror = null;
    if (img.parentElement) {
      img.parentElement.innerHTML = `
        <div class="p-6 text-center text-xs font-medium text-gray-400 flex flex-col items-center justify-center">
          <svg class="w-8 h-8 text-rose-400/80 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          <span class="text-rose-400 font-semibold mb-1">Image preview unavailable</span>
          <span class="text-[11px] text-gray-500">Click "View Full Size" below to open image</span>
        </div>`;
    }
  };

  // Synchronize parent maintenance reports when their child repair tasks are completed/verified
  function syncReportsWithLinkedRepairs(reports) {
    if (!Array.isArray(reports)) return reports;
    let changed = false;
    reports.forEach(report => {
      if (!report) return;
      const isRepTask = isActualRepairTask(report);
      if (isRepTask) {
        if (report.status === 'Under Repair' || report.status === 'Pending' || report.status === 'Assigned' || report.status === 'Needs Repair') {
          const allDone = Array.isArray(report.tasks) && report.tasks.length > 0 && report.tasks.every(t => t.status === 'Completed');
          report.status = allDone ? 'For Verification' : 'In Progress';
          changed = true;
        }
        return;
      }

      // 1. Maintain and clean up linked repair IDs for parent report
      if (report.linkedRepairId) {
        const linkedRep = reports.find(r => r && String(r.id || '').toLowerCase() === String(report.linkedRepairId).toLowerCase());
        const isExplicitParent = linkedRep && (String(linkedRep.parentReportId || linkedRep.linkedParentId || '').toLowerCase() === String(report.id || '').toLowerCase());
        if (!linkedRep || !isExplicitParent) {
          delete report.linkedRepairId;
          if (report.issue && report.issue.linkedRepairId) delete report.issue.linkedRepairId;
          if (Array.isArray(report.tasks)) {
            report.tasks.forEach(t => {
              if (t.linkedRepairId && String(t.linkedRepairId).toLowerCase() === String(report.linkedRepairId).toLowerCase()) {
                delete t.linkedRepairId;
              }
            });
          }
          changed = true;
        }
      }

      // 2. Discover all child repair tasks connected to this parent report
      const childRepairs = getChildRepairReportsFor(report, reports);
      if (childRepairs.length > 0) {
        if (!Array.isArray(report.linkedRepairIds)) report.linkedRepairIds = [];
        childRepairs.forEach(cr => {
          if (cr.id && !report.linkedRepairIds.includes(cr.id)) {
            report.linkedRepairIds.push(cr.id);
            changed = true;
          }
        });
      }

      // 3. Synchronize individual checklist tasks with their specific child repair orders
      if (Array.isArray(report.tasks)) {
        report.tasks.forEach(t => {
          const childRep = getRepairReportForTask(report, t, reports);
          if (!childRep) {
            if (t.linkedRepairId) {
              const directExists = reports.some(r => r && String(r.id || '').toUpperCase() === String(t.linkedRepairId).toUpperCase());
              if (!directExists) {
                delete t.linkedRepairId;
                if (t.status === 'Under Repair' && !t.repaired) {
                  t.status = 'Needs Repair';
                }
                changed = true;
              }
            }
            return;
          }

          if (t.linkedRepairId !== childRep.id) {
            t.linkedRepairId = childRep.id;
            changed = true;
          }

          // Bidirectionally synchronize photos between parent checklist task and child repair order
          const tPhotos = (Array.isArray(t.photoUris) && t.photoUris.length > 0)
            ? t.photoUris.filter(Boolean)
            : ((Array.isArray(t.photos) && t.photos.length > 0) ? t.photos.filter(Boolean) : (t.photo ? [t.photo] : []));
          const cPhotos = (Array.isArray(childRep.photos) && childRep.photos.length > 0)
            ? childRep.photos.filter(Boolean)
            : ((Array.isArray(childRep.photoUris) && childRep.photoUris.length > 0)
              ? childRep.photoUris.filter(Boolean)
              : ((childRep.issue && Array.isArray(childRep.issue.photos) && childRep.issue.photos.length > 0)
                ? childRep.issue.photos.filter(Boolean)
                : []));

          if (tPhotos.length > cPhotos.length) {
            childRep.photos = [...tPhotos];
            childRep.photoUris = [...tPhotos];
            if (!childRep.photo_url && tPhotos[0]) childRep.photo_url = tPhotos[0];
            if (!childRep.issue) childRep.issue = {};
            childRep.issue.photos = [...tPhotos];
            childRep.issue.photoUris = [...tPhotos];
            if (!childRep.issue.photo) childRep.issue.photo = tPhotos[0];
            if (!childRep.issue.photoUri) childRep.issue.photoUri = tPhotos[0];
            changed = true;
          } else if (cPhotos.length > tPhotos.length) {
            t.photos = [...cPhotos];
            t.photoUris = [...cPhotos];
            if (!t.photo && cPhotos[0]) t.photo = cPhotos[0];
            if (!t.photoUri && cPhotos[0]) t.photoUri = cPhotos[0];
            changed = true;
          }

          const isChildVerified = isRepairReportVerified(childRep);
          const isChildDone = isRepairReportDone(childRep);

          if (isChildVerified) {
            if (t.status !== 'Completed' || !t.repaired || !t.verified) {
              t.status = 'Completed';
              t.repaired = true;
              t.verified = true;
              if (!t.verifiedAt) t.verifiedAt = new Date().toISOString();
              t.updated = 'Just now';
              changed = true;
            }
          } else if (isChildDone) {
            if (t.status !== 'Completed' || !t.repaired || t.verified) {
              t.status = 'Completed';
              t.repaired = true;
              t.verified = false;
              t.updated = 'Just now';
              changed = true;
            }
          } else {
            // Child repair is still active/in progress: strictly reset task status
            if (t.status !== 'Under Repair' || t.repaired || t.verified) {
              t.status = 'Under Repair';
              t.repaired = false;
              t.verified = false;
              t.updated = 'Just now';
              changed = true;
            }
          }
        });
      }

      // 4. Recalculate parent report's overall status based on the aggregate status of all tasks
      if (Array.isArray(report.tasks) && report.tasks.length > 0) {
        const hasNeedsRepairTask = report.tasks.some(t => t.status === 'Needs Repair' && !t.repaired);
        const hasUnderRepairTask = report.tasks.some(t => {
          if (t.status === 'Under Repair' && !t.repaired) return true;
          const cr = getRepairReportForTask(report, t, reports);
          return Boolean(cr && !isRepairReportDone(cr));
        });
        const allTasksDone = report.tasks.every(t => {
          const cr = getRepairReportForTask(report, t, reports);
          if (cr && !isRepairReportDone(cr)) return false;
          return t.status === 'Completed' || t.repaired;
        });
        const allTasksVerified = allTasksDone && report.tasks.every(t => t.verified);

        if (hasNeedsRepairTask) {
          if (report.status !== 'Needs Repair' || report.verified) {
            report.status = 'Needs Repair';
            report.verified = false;
            changed = true;
          }
          if (report.issue) {
            report.issue.repaired = false;
            report.issue.status = 'Needs Repair';
          }
        } else if (hasUnderRepairTask) {
          if (report.status !== 'Under Repair' || report.verified) {
            report.status = 'Under Repair';
            report.verified = false;
            changed = true;
          }
          if (report.issue) {
            report.issue.repaired = false;
            report.issue.status = 'Under Repair';
          }
        } else if (allTasksVerified) {
          if (report.status !== 'Completed' || !report.verified) {
            report.status = 'Completed';
            report.verified = true;
            changed = true;
          }
          if (report.issue) {
            report.issue.repaired = true;
            report.issue.status = 'Repaired';
          }
        } else if (allTasksDone) {
          if (report.status !== 'For Verification' && report.status !== 'Completed' && report.status !== 'Closed') {
            report.status = 'For Verification';
            changed = true;
          }
          if (report.issue) {
            report.issue.repaired = true;
            report.issue.status = 'Repaired';
          }
        }
      }
    });
    if (changed) {
      try {
        localStorage.setItem('ecoTrack_maintenance_reports', JSON.stringify(reports));
      } catch (_) { }
    }
    return reports;
  }

  function getReportsLocal() {
    try {
      const stored = localStorage.getItem('ecoTrack_maintenance_reports');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const filtered = parsed.map(normalizeReport).filter(r => r && !isMockOrTestReport(r));
          const list = deduplicateReports(filtered);
          return syncReportsWithLinkedRepairs(list);
        }
      }
    } catch (e) {
      console.warn('Error reading maintenance reports from local storage:', e);
    }
    if (Array.isArray(_reportsCache) && _reportsCache.length > 0) {
      return _reportsCache.filter(r => r && !isMockOrTestReport(r));
    }
    return [];
  }

  function mergeReportsSafely(remoteData, localReports, readRevision = reportWriteRevision) {
    // Successful full reads are authoritative, including deletions and empty lists.
    // Retain only writes confirmed after this read started, to avoid a read/save race.
    const merged = Array.isArray(remoteData) ? remoteData.map(normalizeReport).filter(Boolean) : [];
    for (const [id, write] of confirmedReportWrites) {
      if (write.revision <= readRevision) continue;
      const record = normalizeReport(write.record);
      const index = merged.findIndex(item => item.id === id);
      if (index >= 0) merged[index] = record; else merged.push(record);
    }
    merged.sort((a, b) => {
      const timeA = Date.parse(a.created || a.created_date || a.createdDate) || 0;
      const timeB = Date.parse(b.created || b.created_date || b.createdDate) || 0;
      return timeB - timeA || String(b.id || '').localeCompare(String(a.id || ''), undefined, { numeric: true });
    });
    return syncReportsWithLinkedRepairs(deduplicateReports(merged));
  }

  let _isRefreshingReportsView = false;
  function refreshPageReportsView() {
    if (_isRefreshingReportsView) return;
    _isRefreshingReportsView = true;
    try {
      if (typeof window.renderPageReports === 'function') {
        try { window.renderPageReports(); } catch (e) { console.warn('[renderPageReports error]:', e); }
      }
      try {
        window.dispatchEvent(new CustomEvent('ecotrack:reports-updated', { detail: _reportsCache }));
      } catch (_) { }
      try {
        broadcastMaintenanceChange('UPDATED');
      } catch (_) { }
    } finally {
      _isRefreshingReportsView = false;
    }
  }

  function invalidateReportsCache() {
    _reportsCache = getReportsLocal();
    return _reportsCache;
  }

  // Multi-tab BroadcastChannel for instant cross-tab sync
  let _maintBroadcastBus = null;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      _maintBroadcastBus = new BroadcastChannel('ecotrack_maintenance_bus');
      _maintBroadcastBus.onmessage = (e) => {
        if (e.data && e.data.type === 'MAINTENANCE_UPDATED') {
          console.log('[Maintenance BroadcastBus] Received update from another tab/window');
          _reportsCache = getReportsLocal();
          if (currentDetailId) {
            try { renderDetailModalContent(); } catch (_) { }
          }
          if (activeChecklistReportId) {
            try { renderCurrentChecklistItemModal(); } catch (_) { }
          }
          refreshPageReportsView();
        }
      };
    }
  } catch (_) { }

  function broadcastMaintenanceChange(reason = 'UPDATED') {
    try {
      if (_maintBroadcastBus) {
        _maintBroadcastBus.postMessage({ type: 'MAINTENANCE_UPDATED', reason, timestamp: Date.now() });
      }
    } catch (_) { }
  }

  // Cross-tab storage listener
  window.addEventListener('storage', (e) => {
    if (!e.key || e.key === 'ecoTrack_maintenance_reports') {
      _reportsCache = getReportsLocal();
      if (currentDetailId) {
        try { renderDetailModalContent(); } catch (_) { }
      }
      if (activeChecklistReportId) {
        try { renderCurrentChecklistItemModal(); } catch (_) { }
      }
      refreshPageReportsView();
    }
  });

  function renderCurrentChecklistItemModal() {
    if (!activeChecklistReportId || !activeChecklistTaskId) return;
    const reports = getReports();
    const report = findReportById(reports, activeChecklistReportId);
    if (!report || !Array.isArray(report.tasks)) return;
    const numIdx = parseInt(activeChecklistTaskId, 10);
    const task = report.tasks.find(t =>
      (t.id !== undefined && t.id !== null && (String(t.id) === String(activeChecklistTaskId) || t.id == activeChecklistTaskId)) ||
      (t.name && activeChecklistTaskId && String(t.name).trim().toLowerCase() === String(activeChecklistTaskId).trim().toLowerCase())
    ) || (!isNaN(numIdx) && numIdx > 0 && report.tasks[numIdx - 1]) || report.tasks[0];
    if (task) {
      renderChecklistItemModalContent(report, task);
    }
  }

  function getReports() {
    if (!_reportsCache || !_reportsCache.length) _reportsCache = getReportsLocal();
    // Edit detached records so failed writes cannot mutate the authoritative cache.
    return deduplicateReports(JSON.parse(JSON.stringify(_reportsCache)));
  }

  let reportsFetchPromise = null;
  let reportsFetchPending = false;
  let reportsAuthoritativePending = false;
  let reportRowsRead = null;
  let reportReadClient = null;
  let reportAuthVersion = 0;
  function ensureReportReadSession(sb) {
    if (reportReadClient === sb) return;
    reportReadClient = sb;
    reportAuthVersion += 1;
    reportRowsRead = null;
    confirmedReportWrites.clear();
    sb.auth?.onAuthStateChange?.(() => {
      if (reportReadClient !== sb) return;
      reportAuthVersion += 1;
      reportRowsRead = null;
      confirmedReportWrites.clear();
      if (reportsFetchPromise) reportsFetchPending = true;
    });
  }
  function readMaintenanceRows(sb) {
    ensureReportReadSession(sb);
    if (reportRowsRead?.client === sb) return reportRowsRead.promise;
    const request = { client: sb, promise: null };
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timeout;
    request.promise = Promise.resolve(window.ecotrackAuthReady).then(async () => {
      if (typeof sb.auth?.getSession === 'function') {
        const { data, error } = await sb.auth.getSession();
        if (error) throw error;
        if (!data?.session) throw new Error('Sign in to refresh maintenance reports.');
      }
      let query = sb.from('maintenance_reports').select('*').order('created', { ascending: false });
      if (controller && typeof query.abortSignal === 'function') query = query.abortSignal(controller.signal);
      return Promise.race([
        Promise.resolve(query),
        new Promise((_, reject) => { timeout = setTimeout(() => {
          controller?.abort();
          reject(new Error('Supabase fetch timed out (2.5s)'));
        }, 2500); })
      ]);
    }).finally(() => {
      clearTimeout(timeout);
      if (reportRowsRead === request) reportRowsRead = null;
    });
    reportRowsRead = request;
    return request.promise;
  }
  function fetchReportsFromSupabase(isSilent = false, authoritative = false) {
    reportsFetchPending = true;
    reportsAuthoritativePending ||= authoritative;
    if (reportsFetchPromise) return reportsFetchPromise;
    reportsFetchPromise = Promise.resolve().then(async () => {
      try {
        let silent = isSilent;
        while (reportsFetchPending) {
          reportsFetchPending = false;
          const replace = reportsAuthoritativePending;
          reportsAuthoritativePending = false;
          await performReportsFetch(silent, replace);
          silent = true;
        }
        return _reportsCache;
      } finally { reportsFetchPromise = null; }
    });
    return reportsFetchPromise;
  }
  async function performReportsFetch(isSilent = false, authoritative = false) {
    const sb = getSb();
    const tbody = document.getElementById('pageReportTableBody');
    const hasLocalData = Array.isArray(_reportsCache) && _reportsCache.length > 0;

    // Only render skeletons if we truly have NO local cached reports to display
    if (!isSilent && !hasLocalData && tbody) {
      window.EcoTrackSkeletons?.renderTableSkeleton('pageReportTableBody', {
        rows: 5,
        cols: 10,
        colWidths: ['w-24', 'w-28', 'w-28', 'w-24', 'w-20', 'w-32', 'w-24', 'w-20', 'w-24', 'w-20']
      });
      window.EcoTrackSkeletons?.renderStatsSkeleton('pageMaintStats', { count: 7 });
    }

    if (sb) {
      try {
        ensureReportReadSession(sb);
        const authVersion = reportAuthVersion;
        const readRevision = reportWriteRevision;
        const { data, error } = await readMaintenanceRows(sb);
        if (authVersion !== reportAuthVersion) return _reportsCache;
        if (!error && Array.isArray(data)) {
          data.forEach(record => reportVersions.set(record.id, record.updated));
          const localExisting = authoritative ? [] : ((_reportsCache && _reportsCache.length > 0) ? _reportsCache : getReportsLocal());
          _reportsCache = mergeReportsSafely(data, localExisting, readRevision);
          try {
            localStorage.setItem('ecoTrack_maintenance_reports', JSON.stringify(_reportsCache));
          } catch (e) { }
          window.dispatchEvent(new Event('storage'));

        }
      } catch (err) {
        console.warn('[Supabase maintenance load]:', err.message);
      } finally {
        // GUARANTEED: Skeletons are ALWAYS removed and latest data is rendered
        refreshPageReportsView();
        window.dispatchEvent(new CustomEvent('ecotrack:reports-updated', { detail: _reportsCache }));
        if (currentDetailId) {
          try { renderDetailModalContent(); } catch (_) { }
        }
        if (activeChecklistReportId) {
          try { renderCurrentChecklistItemModal(); } catch (_) { }
        }
        if (activeRepairReportId) {
          const currentRep = findReportById(_reportsCache, activeRepairReportId);
          if (currentRep) {
            activeRepairReport = currentRep;
            try { renderRepairTaskModalContent(currentRep); } catch (_) { }
          }
        }
      }
      return _reportsCache;
    }
    _reportsCache = getReportsLocal();
    refreshPageReportsView();
    return _reportsCache;
  }

  function isReportUnverified(status) {
    const s = String(status || '').toLowerCase().trim();
    // Only Verified, Completed and Closed are considered fully finished. Reports awaiting Admin Verification remain active.
    return s !== 'verified' && s !== 'closed' && s !== 'completed';
  }

  function findActiveUnverifiedReportForAircon(targetAirconId, targetNodeId = null, excludeReportId = null) {
    if (!targetAirconId) return null;
    const reports = getReports();
    const lowerTarget = String(targetAirconId).toLowerCase().trim();
    const lowerNode = targetNodeId ? String(targetNodeId).toLowerCase().trim() : null;

    return reports.find(r => {
      if (excludeReportId && r.id === excludeReportId) return false;

      const rAircon = String(r.airconId || r.aircon_name || r.aircon_id || '').toLowerCase().trim();
      const rNode = String(r.node_id || r.nodeId || r.aircon_id || '').toLowerCase().trim();

      const matchesAircon = (rAircon && (rAircon === lowerTarget || (lowerNode && rAircon === lowerNode))) ||
        (lowerNode && rNode && rNode === lowerNode);

      if (!matchesAircon) return false;

      // Report must currently be in an unverified state (Pending, Assigned, In Progress, For Verification, Needs Repair)
      return isReportUnverified(r.status);
    }) || null;
  }

  async function resolveMaintenanceReference(table, candidateId, candidateName, label) {
    const sb = getSb();
    const id = String(candidateId || '').trim(), name = String(candidateName || '').trim();
    if (!id && !name) return null;
    let rows, error;
    if (id) {
      const result = await sb.from(table).select('id').eq('id', id).maybeSingle();
      error = result.error;
      rows = result.data ? [result.data] : [];
    } else {
      const result = await sb.from(table).select('id').eq('name', name).limit(2);
      error = result.error;
      rows = result.data || [];
    }
    if (error) throw error;
    if (rows.length !== 1) {
      const failure = new Error(`Selected ${label} no longer exists or is ambiguous. Refresh and choose an existing ${label}.`);
      failure.code = 'INVALID_REFERENCE';
      throw failure;
    }
    return rows[0].id;
  }

  function resolveValidNodeId(candidateId, candidateName) {
    return resolveMaintenanceReference('nodes', candidateId, candidateName, 'controller');
  }

  function resolveValidRoomId(candidateId, candidateName) {
    return resolveMaintenanceReference('rooms', candidateId, candidateName, 'room');
  }

  function resolveValidStaffId(candidateId, candidateName) {
    const id = String(candidateId || '').trim();
    if (/^(?:staff_|stf_|usr_)?[a-zA-Z0-9_-]{6,64}$/.test(id)) return id;
    const staff = getStaffList().filter(person => person && person.name === candidateName);
    return staff.length === 1 && /^(?:staff_|stf_|usr_)?[a-zA-Z0-9_-]{6,64}$/.test(String(staff[0].id)) ? staff[0].id : null;
  }

  const pendingReportOperations = new Map();

  async function saveReports(reports, targetReport = null, isNewReport = false, updateProgress = false) {
    // Defense-in-depth: Halt if creating a duplicate for a unit that already has an unverified report
    const isSpecialTaskType = targetReport && (
      targetReport.type === 'Corrective Repair' ||
      targetReport.type === 'Repair Task' ||
      targetReport.type === 'Maintenance Rework' ||
      targetReport.type === 'Rework'
    );
    if (isNewReport && targetReport && !isSpecialTaskType) {
      const activeDup = findActiveUnverifiedReportForAircon(targetReport.airconId || targetReport.aircon_name, targetReport.aircon_id, targetReport.id);
      if (activeDup && activeDup.id !== targetReport.id) {
        console.warn('[saveReports] Blocked duplicate report for aircon with active unverified report:', activeDup.id);
        throw new Error(`Aircon unit already has an ongoing unverified report (${activeDup.id}) with status "${activeDup.status}". Duplicate reporting is halted.`);
      }
    }

    if (!targetReport) return;
    if (!targetReport.id) throw new Error('A report ID is required to save.');

    const sb = getSb();
    if (sb && targetReport) {
      try {
        await window.ecotrackAuthReady;
        const validNodeId = await resolveValidNodeId(
          targetReport.aircon_id || targetReport.nodeId || targetReport.node_id,
          targetReport.aircon_name || targetReport.airconId
        );
        const safeNodeId = validNodeId;

        const validRoomId = await resolveValidRoomId(
          targetReport.room_id || targetReport.roomId,
          targetReport.room_name || targetReport.room
        );
        const safeRoomId = validRoomId;

        const validStaffId = resolveValidStaffId(
          targetReport.staff_id || targetReport.staffId,
          targetReport.staff_name || targetReport.staffName
        );
        const safeStaffId = validStaffId;

        const payload = {
          id: targetReport.id,
          aircon_id: safeNodeId,
          aircon_name: targetReport.aircon_name || targetReport.airconId || (safeNodeId ? 'AC Unit' : 'AC-Unassigned'),
          aircon_type: targetReport.aircon_type || targetReport.airconType || null,
          room_id: safeRoomId,
          room_name: targetReport.room_name || targetReport.room || 'Unassigned',
          type: targetReport.type,
          priority: targetReport.priority,
          staff_id: safeStaffId,
          staff_name: targetReport.staff_name || targetReport.staffName || 'Unassigned',
          due_date: targetReport.due_date || targetReport.dueDate || '',
          created_date: targetReport.created_date || targetReport.createdDate || '',
          status: targetReport.status,
          update_progress: updateProgress,
          description: targetReport.description || '',
          tasks: targetReport.tasks,
          issue: targetReport.issue,
          verification_remarks: targetReport.verification_remarks || targetReport.verificationRemarks || '',
          timeline: targetReport.timeline,
          parent_report_id: targetReport.parent_report_id || targetReport.parentReportId || null,
          linked_repair_id: targetReport.linked_repair_id || targetReport.linkedRepairId || null,
          photo_url: targetReport.photo_url || targetReport.photoUrl || (targetReport.issue && (targetReport.issue.photoUri || targetReport.issue.photo)) || null,
          photos: Array.isArray(targetReport.photos) ? targetReport.photos : (Array.isArray(targetReport.photoUris) ? targetReport.photoUris : []),
          created: targetReport.created || new Date().toISOString(),
          updated: new Date().toISOString()
        };
        const parent = reports.find(item => item.id === payload.parent_report_id);
        const loadedVersion = targetReport.id === editingReportId ? editingReportVersion :
          targetReport.id === activeEditRepairId ? activeEditRepairReport?.updated : targetReport.updated || targetReport.updated_at || targetReport.updatedAt;
        const expectedUpdated = isNewReport ? null : loadedVersion || reportVersions.get(targetReport.id) || null;
        const parentExpected = parent?.updated || parent?.updated_at || reportVersions.get(payload.parent_report_id) || null;
        // The server owns updated timestamps; retain the version this edit loaded.
        delete payload.updated;
        const signature = JSON.stringify([payload, expectedUpdated, parentExpected, isNewReport]);
        let operation = pendingReportOperations.get(targetReport.id);
        if (!operation || operation.signature !== signature) {
          operation = { signature, id: 'desktop-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) };
          pendingReportOperations.set(targetReport.id, operation);
        }
        await window.ecotrackAuthReady;
        let result = null;
        if (window.electron?.invoke) {
          try {
            result = await window.electron.invoke('maintenance-save-report', { record: payload, expectedUpdated, parentExpected, operationId: operation.id, isNew: isNewReport });
          } catch (ipcErr) {
            console.warn('[saveReports] Electron IPC save notice:', ipcErr?.message);
          }
        }
        if (!result) {
          try {
            const response = await sb.rpc('ecotrack_admin_save_report', { p_record: payload, p_expected_updated: expectedUpdated, p_parent_expected: parentExpected, p_operation_id: operation.id, p_create: isNewReport });
            result = { success: !response.error, data: response.data, error: response.error?.message, code: response.error?.code };
          } catch (rpcErr) {
            console.warn('[saveReports] Direct RPC invoke notice:', rpcErr?.message);
          }
        }

        // Concurrency Conflict Check
        if (result && result.code === '40001') {
          const error = new Error('This report changed. Refresh the report before saving again.');
          error.code = '40001';
          throw error;
        }

        if (!result?.success || result?.data?.report?.id !== payload.id) {
          const failure = new Error(result?.error || 'Database did not confirm the report save. Refresh and retry; the previous state has been preserved.');
          failure.code = result?.code;
          throw failure;
        }

        pendingReportOperations.delete(targetReport.id);
        reportWriteRevision += 1;
        for (const record of [result.data.report, result.data.parent].filter(Boolean)) {
          reportVersions.set(record.id, record.updated);
          confirmedReportWrites.set(record.id, { revision: reportWriteRevision, record: JSON.parse(JSON.stringify(record)) });
          const normalized = normalizeReport(record);
          // Update existing references as well as the cache so linked repair saves use the new parent version.
          for (const item of reports) if (item.id === record.id) Object.assign(item, normalized);
          if (targetReport.id === record.id) Object.assign(targetReport, normalized);
          const index = _reportsCache.findIndex(item => item.id === record.id);
          if (index >= 0) _reportsCache[index] = normalized; else _reportsCache.push(normalized);
        }
        _reportsCache = syncReportsWithLinkedRepairs(deduplicateReports(_reportsCache));
        localStorage.setItem('ecoTrack_maintenance_reports', JSON.stringify(_reportsCache));
        window.dispatchEvent(new Event('storage'));
        window.dispatchEvent(new CustomEvent('ecotrack:reports-updated', { detail: _reportsCache }));
        broadcastMaintenanceChange('SAVED_REPORTS');
        refreshPageReportsView();
        // The transactional RPC/notification trigger dispatches once after a successful save.
      } catch (error) {
        if (error.code === '40001') await fetchReportsFromSupabase(false, true);
        if (typeof showToast === 'function') showToast('Report not saved', error.message, 'warning');
        throw error;
      }
    } else if (targetReport) {
      const error = new Error('Database connection is unavailable. The report was not saved.');
      if (typeof showToast === 'function') showToast('Report not saved', error.message, 'warning');
      throw error;
    }
  }

  let _nodesAirconCache = [];
  let _staffRoomHierarchy = null;
  function updateStaffLocationHierarchy(rooms, floors, buildings) {
    const floorMap = new Map(floors.map(item => [String(item.id), item]));
    const buildingMap = new Map(buildings.map(item => [String(item.id), item]));
    _staffRoomHierarchy = new Map(rooms.map(room => {
      const floor = floorMap.get(String(room.floor_id));
      const building = floor && buildingMap.get(String(floor.building_id));
      return [String(room.id), { roomId: room.id, roomName: room.name || '',
        floorId: floor?.id || '', floorName: floor?.name || '',
        buildingId: building?.id || '', buildingName: building?.name || '',
        assignment: [building?.name, floor?.name, room.name].filter(Boolean).join(' • ') }];
    }));
    window.dispatchEvent(new CustomEvent('ecotrack:locations-updated'));
  }
  function resolveStaffHierarchy(staff) {
    const roomId = String(staff?.room_id || staff?.roomId || '').trim();
    if (!_staffRoomHierarchy || !roomId || ['all','all_rooms'].includes(roomId.toLowerCase())) return null;
    return _staffRoomHierarchy.get(roomId) || { roomId, roomName: 'Unassigned',
      floorId: '', floorName: '', buildingId: '', buildingName: '', assignment: 'Unassigned' };
  }
  window.addEventListener?.('devices:synced', () => {
    _nodesAirconCache = [];
    localStorage.removeItem('ecoTrack_aircons_cache');
  });

  function formatBatteryDisplay(rawVal, isOnline = true) {
    const unknown = { val: 'Unavailable', status: isOnline ? 'Unavailable' : 'Offline',
      code: isOnline ? 'unknown' : 'offline' };
    if (!['number', 'string'].includes(typeof rawVal)) return unknown;
    const match = String(rawVal).trim().match(/^(-?(?:\d+(?:\.\d+)?|\.\d+))\s*(%|v)?$/i);
    if (!match) return unknown;
    const num = Number(match[1]);
    const voltage = String(match[2] || '').toLowerCase() === 'v';
    if (!Number.isFinite(num) || num < 0 || (!voltage && num > 100)) return unknown;
    // nodes.battery is a reported percentage, including 0..5%. Explicit legacy
    // voltage strings retain their unit; do not invent a charge percentage.
    const val = voltage ? `${num} V` : `${Math.round(num)}%`;
    const isWarning = voltage ? num < 3.3 : num < 25;
    return {
      val,
      status: isOnline ? val : 'Offline',
      code: !isOnline ? 'offline' : (isWarning ? 'warning' : 'healthy')
    };
  }

  function maintenanceControllerDiagnostics(measurements = {}, deviceState = null, now = Date.now()) {
    const seen = Date.parse(deviceState?.last_seen || '');
    const wake = Date.parse(deviceState?.sleeping_until || '');
    const validSeen = Number.isFinite(seen) && seen <= now + 5000;
    const sleeping = validSeen && Number.isFinite(wake) && wake > now && wake > seen;
    const online = validSeen && !sleeping && now - seen <= 45000;
    const state = sleeping ? 'Sleeping' : online ? 'Online' : 'Offline';
    function reading(raw, unit) {
      const number = ['number', 'string'].includes(typeof raw) && String(raw).trim() !== '' ? Number(raw) : NaN;
      const available = Number.isFinite(number);
      return { status: online ? (available ? 'Connected' : 'Unavailable') : state,
        val: available ? `${number}${unit}` : 'Unavailable',
        code: online ? (available ? 'healthy' : 'unknown') : 'offline' };
    }
    return { state, controls: {
      temp: { name: 'Temperature', ...reading(measurements.temp, '°C') },
      pressure: { name: 'Air Pressure', ...reading(measurements.pressure, measurements.pressure_unit==='Pa' ? ' Pa' : ' kPa') },
      battery: { name: 'Battery', ...formatBatteryDisplay(measurements.battery, online) },
      signal: { name: 'Signal', ...reading(measurements.rssi, ' dBm') }
    } };
  }
  function currentMaintenanceControllers(rows) {
    return rows.filter(row=>window.EcoTrackMode?.mode==='monitoring' ? ['monitoring','both'].includes(row.deviceMode) : window.EcoTrackMode?.mode==='controller' ? row.deviceMode!=='monitoring' : true).map(row => ({ ...row,
      ...maintenanceControllerDiagnostics(row.measurements || {}, row.deviceState || null) }));
  }

  function maintenanceDisplayText(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function maintenanceDeviceLabel() {
    return window.EcoTrackMode?.mode==='monitoring' ? 'AC Sensor Device' : window.EcoTrackMode?.mode==='both' ? 'AC Device' : 'AC Controller';
  }
  function maintenanceControllerName(ac) {
    if (ac.id === 'None') return window.EcoTrackMode?.mode==='monitoring' ? 'No sensor device assigned' : window.EcoTrackMode?.mode==='both' ? 'No AC device assigned' : 'No controller assigned';
    const service = window.EcoTrackAirconSystem?.NodeService;
    const controller = ac.nodeId ? service?.getNode?.(ac.nodeId) : null;
    return [controller?.name, ac.nodeName].map(value => String(value || '').trim()).find(value => value &&
      value !== String(ac.nodeId || '') && !/^(?:AC-)?esp32s3-[a-f0-9]{12}$/i.test(value)) ||
      (ac.nodeId ? window.EcoTrackMode?.mode && window.EcoTrackMode.mode!=='controller' ? 'Unnamed '+maintenanceDeviceLabel().toLowerCase() : 'Unnamed controller' : window.EcoTrackMode?.mode && window.EcoTrackMode.mode!=='controller' ? maintenanceDeviceLabel()+' unavailable' : 'Controller unavailable');
  }

  function maintenanceAirconType(...values) {
    const value = values.map(item => String(item || '').trim()).find(Boolean);
    if (!value) return 'Type unavailable';
    // Older report snapshots joined a protocol/manufacturer label to the physical type.
    return value.replace(/^.+?\s+[-–—]\s+(?=(?:split|window|cassette|ducted?|portable|floor|ceiling|central|wall|tower|multi[- ]split)\b)/i, '');
  }

  function findMaintenanceAircon(report, aircons = getAirconsDatabase()) {
    const unique = rows => {
      const matches = new Map(rows.map(ac => [ac.airconId || ac.nodeId || ac.id,ac]));
      return matches.size === 1 ? [...matches.values()][0] : null;
    };
    // Legacy maintenance aircon_id references nodes, while newer clients may provide an AC ID.
    const references = [report.aircon_id,report.node_id,report.nodeId,report.controller_node_id]
      .map(value => String(value || '').trim()).filter(Boolean);
    const exact = aircons.filter(ac => [ac.airconId,ac.nodeId,ac.id].some(value => value && references.includes(String(value))));
    if (exact.length) return unique(exact);
    const profiles = (window.EcoTrackAirconSystem?.AirconProfileManager?.getAll?.() || [])
      .filter(ac => [ac.aircon_id,ac.controller_node_id,ac.node_id,ac.device_id].some(value => value && references.includes(String(value))));
    const profileMap = new Map(profiles.map(ac => [ac.aircon_id || ac.device_id,ac]));
    if (profileMap.size === 1) {
      const profile = [...profileMap.values()][0];
      const linked = aircons.filter(ac => (ac.airconId && ac.airconId === profile.aircon_id) || (ac.id && ac.id === profile.device_id) ||
        (ac.nodeId && [profile.controller_node_id,profile.node_id].includes(ac.nodeId)));
      if (linked.length) return unique(linked);
      return {id:profile.device_id,airconId:profile.aircon_id,airconName:profile.name,
        nodeId:profile.controller_node_id || profile.node_id,airconType:profile.aircon_type || profile.model,
        room:profile.room_name,building:profile.building || profile.building_name,floor:profile.floor || profile.floor_name};
    }
    // Never redirect a missing stable reference to another unit that happens to share its old name.
    if (references.length) return null;
    const aliases = [report.airconId,report.aircon_name].map(value => String(value || '').trim()).filter(Boolean);
    return unique(aircons.filter(ac => [ac.id,ac.assetTag,ac.airconName,ac.model].some(value => value && aliases.includes(String(value)))));
  }

  function maintenanceReportEquipment(report, aircon = findMaintenanceAircon(report)) {
    const profiles = window.EcoTrackAirconSystem?.AirconProfileManager?.getAll?.() || [];
    const profileMatches = aircon ? profiles.filter(ac => (aircon.airconId && ac.aircon_id === aircon.airconId) || (aircon.id && ac.device_id === aircon.id)) : [];
    const profile = profileMatches.length === 1 ? profileMatches[0] : null;
    const controllerName = aircon ? maintenanceControllerName(aircon) : (window.EcoTrackMode?.mode && window.EcoTrackMode.mode!=='controller' ? maintenanceDeviceLabel()+' unavailable' : 'Controller unavailable');
    const rawName = String(profile?.name || aircon?.airconName || report.aircon_name || '').trim();
    const airconName = rawName && !/^(?:AC-)?esp32s3-[a-f0-9]{12}$/i.test(rawName) &&
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(rawName) &&
      ![report.aircon_id,profile?.controller_node_id,profile?.node_id].some(id => id && String(id) === rawName) ? rawName : 'Aircon name unavailable';
    return {controllerName,airconName,
      airconType:maintenanceAirconType(profile?.aircon_type, profile?.model, aircon?.airconType, report.aircon_type, report.airconType),
      location:[aircon?.building || report.building_name,aircon?.floor || report.floor_name,aircon?.room || report.room_name || report.room].filter(Boolean).join(' • ') || 'Location unavailable',
      protocol:profile?.protocol_name || profile?.protocol || aircon?.protocolName || 'Unavailable'};
  }

  function maintenanceStateClasses(state) {
    return state === 'Online'
      ? 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 border-emerald-400/40'
      : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-600';
  }

  function renderMaintenanceDiagnostics(ac) {
    return [['temp', 'Temp', 'Temperature'], ...(window.EcoTrackMode?.mode==='monitoring' ? [['pressure','Pressure','Air pressure']] : []), ['signal', 'Wi-Fi', 'Wi-Fi signal'], ['battery', 'Battery', 'Battery']]
      .map(([key, label, fullLabel]) => {
        const reading = ac.controls?.[key];
        const available = reading?.val && reading.val !== 'Unavailable';
        const last = available && ac.state !== 'Online';
        const value = available ? `${last ? 'Last ' : ''}${reading.val}` : 'No data';
        const description = `${fullLabel}: ${value}; controller ${ac.state || 'Unavailable'}`;
        const dot = reading?.code === 'healthy' ? 'bg-emerald-500'
          : reading?.code === 'warning' ? 'bg-amber-500' : 'bg-slate-400';
        return `<span data-maintenance-diagnostic="${key}" title="${maintenanceDisplayText(description)}" aria-label="${maintenanceDisplayText(description)}"
          class="inline-flex items-center gap-1.5 max-w-full px-2 py-1 rounded-md bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 text-[11px] text-slate-700 dark:text-slate-200">
          <span aria-hidden="true" class="w-1.5 h-1.5 rounded-full shrink-0 ${dot}"></span>
          <span class="font-medium">${label}:</span><span>${maintenanceDisplayText(value)}</span>
        </span>`;
      }).join('');
  }

  function getAirconsDatabase() {
    if (_nodesAirconCache && _nodesAirconCache.length > 0) {
      return currentMaintenanceControllers(_nodesAirconCache);
    }
    try {
      const cached = localStorage.getItem('ecoTrack_aircons_cache');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length > 0) {
          _nodesAirconCache = parsed;
          return currentMaintenanceControllers(_nodesAirconCache);
        }
      }
    } catch (_) {}

    if (window.EcoTrackAirconSystem?.AirconProfileManager?.getAll) {
      const apmList = window.EcoTrackAirconSystem.AirconProfileManager.getAll();
      if (Array.isArray(apmList) && apmList.length > 0) {
        _nodesAirconCache = apmList.map(a => {
          const service = window.EcoTrackAirconSystem.NodeService;
          const controller = (a.controller_node_id ? service?.getNode?.(a.controller_node_id) : null) ||
            (a.node_id ? service?.getNode?.(a.node_id) : null);
          const measurements = controller ? { temp: controller.temp, pressure: controller.pressure,
            battery: controller.cloud_state?.battery ?? controller.battery,
            rssi: controller.cloud_state?.rssi ?? controller.rssi } : {};
          const deviceState = controller?.cloud_state || null;
          return ({
          id: a.device_id || a.name || a.id,
          airconId:a.aircon_id || a.id, airconName:a.name || '', airconType:a.aircon_type || a.model || '', protocolName:a.protocol_name || a.protocol || '',
          assetTag:a.device_id || '', building:a.building || a.building_name || '', floor:a.floor || a.floor_name || '',
          nodeId: controller?.db_id || a.controller_node_id || a.node_id || a.device_id,
          room: a.room_name || a.location || 'Assigned Room',
          roomId: a.room_id || '',
          brand: a.model || a.aircon_type || 'Split Type (Inverter)',
          model: a.name || a.device_id,
          nodeName: controller?.name || a.node_name || '', deviceMode:controller?.device_mode || 'controller',
          measurements, deviceState,
          ...maintenanceControllerDiagnostics(measurements, deviceState)
        });
        });
        return currentMaintenanceControllers(_nodesAirconCache);
      }
    }

    if (window.activeNodesData && window.activeNodesData.length > 0) {
      return window.activeNodesData
        .filter(n => (n.room_id || n.room_name || n.room) && (n.room_id !== '' && n.room !== ''))
        .map(n => ({
          id: n.name || n.id,
          nodeId: n.id,
          room: n.room_name || n.room || 'Assigned Room',
          brand: n.aircon_type || 'Split Type (Inverter)',
          model: n.name || n.id,
          nodeName: n.name || '',deviceMode:n.device_mode || 'controller',
          measurements: { temp: n.temp ?? n.temperature, pressure: n.pressure, battery: n.battery, rssi: n.rssi },
          deviceState: null,
          ...maintenanceControllerDiagnostics({ temp: n.temp ?? n.temperature, pressure: n.pressure, battery: n.battery, rssi: n.rssi })
        }))
        .sort((a, b) => String(a.id || '').localeCompare(String(b.id || ''), undefined, { numeric: true, sensitivity: 'base' }));
    }
    return [];
  }

  async function readMaintenanceSensors() {
    if(window.EcoTrackMode?.mode==='controller')return [];
    try {
      const base=new URL(window.ECOTRACK_CONFIG?.backendUrl || window.electron?.env?.BACKEND_URL || 'http://localhost:5000');
      if(!['localhost','127.0.0.1','[::1]'].includes(base.hostname) || !['http:','https:'].includes(base.protocol))return [];
      const response=await fetch(base.origin+'/api/monitoring/devices',{signal:AbortSignal.timeout(2000),cache:'no-store'});
      return response.ok ? (await response.json()).items || [] : [];
    } catch(_){return [];}
  }
  async function fetchAirconsFromSupabase() {
    const sb = getSb();
    if (sb) {
      try {
        const fetchPromise = Promise.all([
          sb.from('nodes').select('*'),
          sb.from('rooms').select('*'),
          sb.from('floors').select('*'),
          sb.from('buildings').select('*'),
          sb.from('aircons').select('*'),
          sb.from('ecotrack_device_state').select('node_id,last_seen,sleeping_until,rssi'),
          readMaintenanceSensors()
        ]);
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Aircons fetch timed out (2.5s)')), 2500)
        );
        const [nodesRes, roomsRes, floorsRes, buildingsRes, airconsRes, hardwareRes, sensorRows] = await Promise.race([fetchPromise, timeoutPromise]);
        for (const response of [nodesRes, roomsRes, floorsRes, buildingsRes, airconsRes]) {
          if (response.error) throw response.error;
        }
        const hardwareMap = Object.fromEntries((hardwareRes.error ? [] : hardwareRes.data || []).map(row => [String(row.node_id), row]));
        const nodes = nodesRes.data || [];
        const rooms = roomsRes.data || [];
        const floors = floorsRes.data || [];
        const buildings = buildingsRes.data || [];
        const aircons = (airconsRes && airconsRes.data) ? airconsRes.data : [];
        updateStaffLocationHierarchy(rooms, floors, buildings);

        if (nodes && nodes.length > 0) {
          const buildingMap = {};
          buildings.forEach(b => { if (b && b.id) buildingMap[b.id] = b.name || ''; });

          const floorMap = {};
          floors.forEach(fl => {
            if (fl && fl.id) {
              floorMap[fl.id] = {
                id: fl.id,
                name: fl.name || '',
                building_id: fl.building_id || '',
                building_name: buildingMap[fl.building_id] || ''
              };
            }
          });

          const roomMap = {};
          rooms.forEach(rm => {
            if (rm && rm.id) {
              const fl = floorMap[rm.floor_id] || {};
              roomMap[rm.id] = {
                id: rm.id,
                name: rm.name || '',
                floor_id: rm.floor_id || '',
                floor_name: fl.name || '',
                building_id: fl.building_id || '',
                building_name: fl.building_name || ''
              };
            }
          });

          const airconByNodeMap = {};
          if (Array.isArray(aircons)) {
            aircons.forEach(a => {
              if (a && (a.controller_node_id || a.node_id)) {
                airconByNodeMap[a.controller_node_id || a.node_id] = a;
              }
            });
          }

          // Only include nodes assigned to an active room, matching the Telemetry view
          const assignedNodes = nodes.filter(n => n.room_id && roomMap[n.room_id]);

          _nodesAirconCache = (assignedNodes.length > 0 ? assignedNodes : nodes).map(n => {
            const rInfo = roomMap[n.room_id] || {};
            const linkedAc = aircons.find(ac=>ac.id===n.monitor_aircon_id) || airconByNodeMap[n.id] || null;
            const primaryId = n.device_mode==='monitoring' ? 'sensor:'+n.id : linkedAc?.asset_tag || n.name || n.id;
            const deviceState = hardwareMap[String(n.id)] || null;
            const sensor=sensorRows?.find(sensor=>sensor.id===n.monitoring_id), sample=sensor?.fresh ? sensor.latest : null;
            const sensorRole=['monitoring','both'].includes(n.device_mode);
            const measurements = sensorRole ? {temp:sample?.outlet_temperature_c ?? null,pressure:sample?.differential_pressure_pa ?? null,pressure_unit:'Pa',battery:sample?.battery_voltage==null ? null : sample.battery_voltage+' V',rssi:sample?.rssi_dbm ?? deviceState?.rssi ?? null} : { temp: n.temp ?? n.temperature, pressure: n.pressure,
              battery: n.battery, rssi: deviceState?.rssi ?? n.rssi };
            return {
              id: primaryId,
              nodeId: n.id,
              nodeName: n.name || '',deviceMode:n.device_mode || 'controller',
              assetTag: linkedAc ? linkedAc.asset_tag : null,
              airconId:linkedAc?.id || null, airconName:linkedAc?.name || '',
              airconType:linkedAc?.aircon_type || linkedAc?.model || n.aircon_type || '',
              protocolName:linkedAc?.protocol_name || linkedAc?.protocol || n.protocol_name || '',
              room: rInfo.name || n.room_name || n.room || 'Assigned Room',
              roomId: n.room_id || '',
              floor: rInfo.floor_name || n.floor_name || '',
              floorId: rInfo.floor_id || '',
              building: rInfo.building_name || n.building_name || '',
              buildingId: rInfo.building_id || '',
              brand: linkedAc?.aircon_type || linkedAc?.model || n.aircon_type || 'Type unavailable',
              model: linkedAc?.name || primaryId,
              measurements, deviceState,
              ...maintenanceControllerDiagnostics(measurements, deviceState)
            };
          });

          // Sort AC controls naturally (e.g. node-1, node-2, ... EcoTrack-Node-225)
          _nodesAirconCache.sort((a, b) => {
            const nameA = String(a.id || a.model || '');
            const nameB = String(b.id || b.model || '');
            return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
          });

          try {
            localStorage.setItem('ecoTrack_aircons_cache', JSON.stringify(_nodesAirconCache));
          } catch (_) { }

          if (typeof window.updateReportFilters === 'function') window.updateReportFilters();
          window.dispatchEvent(new CustomEvent('ecotrack:aircons-updated', { detail: _nodesAirconCache }));
        } else {
          _nodesAirconCache = [];
          localStorage.removeItem('ecoTrack_aircons_cache');
          if (typeof window.updateReportFilters === 'function') window.updateReportFilters();
          window.dispatchEvent(new CustomEvent('ecotrack:aircons-updated', { detail: [] }));
        }
      } catch (err) {
        console.warn('[Supabase aircons load]:', err.message);
      }
    }
  }

  // Filter AC controls strictly matching the technician's assigned building, floor, and room
  function getStaffBuilding(staff) {
    if (!staff) return '';
    const canonical = resolveStaffHierarchy(staff);
    if (canonical) return canonical.buildingName;
    let bld = (staff.building_name || staff.buildingName || staff.building || '').trim();
    if (!bld && staff.assignment) {
      bld = staff.assignment.split('•')[0].trim();
    }
    return bld;
  }

  function getAirconsForStaff(staff, airconsList) {
    if (!Array.isArray(airconsList) || airconsList.length === 0) return [];
    if (!staff) return airconsList;
    const assignedRoomId = String(staff.room_id || staff.roomId || '').trim();
    if (assignedRoomId && !['all','all_rooms'].includes(assignedRoomId.toLowerCase())) {
      return airconsList.filter(ac => String(ac.roomId || ac.room_id || '') === assignedRoomId);
    }

    // 1. Extract location identifiers and names
    const bldName = (staff.building_name || staff.buildingName || staff.building || '').toLowerCase().trim();
    const flrName = (staff.floor_name || staff.floorName || staff.floor || '').toLowerCase().trim();
    const rmName = (staff.room_name || staff.roomName || staff.room || '').toLowerCase().trim();
    const bldId = (staff.building_id || staff.buildingId || '').trim();
    const flrId = (staff.floor_id || staff.floorId || '').trim();
    const rmId = (staff.room_id || staff.roomId || '').trim();
    const assignment = (staff.assignment || '').toLowerCase().trim();

    // Parse assignment string segments (Building • Floor • Room) as supplementary
    let assignBld = '';
    let assignFlr = '';
    let assignRm = '';
    if (assignment.includes('•')) {
      const parts = assignment.split('•').map(p => p.trim());
      assignBld = parts[0] || '';
      assignFlr = parts[1] || '';
      assignRm = parts[2] || '';
    }

    const effectiveBld = bldName || assignBld;
    const effectiveFlr = flrName || assignFlr;
    const effectiveRm = rmName || assignRm;

    // 2. Check scope levels (Campus-Wide, Building-Wide, Floor-Wide, Room-Specific)
    const isAllBuildings = !effectiveBld ||
      effectiveBld === 'all' ||
      effectiveBld === 'all buildings' ||
      bldId === 'all' ||
      bldId === 'all_buildings' ||
      assignment.includes('all building');

    if (isAllBuildings) {
      return airconsList;
    }

    const isAllFloors = !effectiveFlr ||
      effectiveFlr === 'all' ||
      effectiveFlr === 'all floors' ||
      flrId === 'all' ||
      flrId === 'all_floors' ||
      assignment.includes('all floor');

    const isAllRooms = isAllFloors ||
      !effectiveRm ||
      effectiveRm === 'all' ||
      effectiveRm === 'all rooms' ||
      rmId === 'all' ||
      rmId === 'all_rooms' ||
      assignment.includes('all room');

    // Normalizer: strips common generic suffixes and non-alphanumeric chars
    const norm = (s) => (s || '').toLowerCase()
      .replace(/building/g, '')
      .replace(/floor/g, '')
      .replace(/flr/g, '')
      .replace(/[^a-z0-9]/g, '')
      .trim();

    // 3. Strictly filter aircons matching the technician's assigned hierarchy
    const filtered = airconsList.filter(ac => {
      // A. Building check
      let bldMatch = false;
      if (bldId && ac.buildingId && bldId === ac.buildingId) {
        bldMatch = true;
      } else if (effectiveBld && ac.building) {
        const normStaffBld = norm(effectiveBld);
        const normAcBld = norm(ac.building);
        bldMatch = normStaffBld === normAcBld || normStaffBld.includes(normAcBld) || normAcBld.includes(normStaffBld);
      }
      if (!bldMatch) return false;

      // If assigned to all floors and all rooms of this building
      if (isAllFloors && isAllRooms) return true;

      // B. Floor check
      let flrMatch = false;
      if (isAllFloors) {
        flrMatch = true;
      } else if (flrId && ac.floorId && flrId === ac.floorId) {
        flrMatch = true;
      } else if (effectiveFlr && ac.floor) {
        const normStaffFlr = norm(effectiveFlr);
        const normAcFlr = norm(ac.floor);
        flrMatch = normStaffFlr === normAcFlr || normStaffFlr.includes(normAcFlr) || normAcFlr.includes(normStaffFlr);
      }
      if (!flrMatch) return false;

      // If assigned to all rooms on this floor
      if (isAllRooms) return true;

      // C. Room check
      let rmMatch = false;
      if (rmId && ac.roomId && rmId === ac.roomId) {
        rmMatch = true;
      } else {
        const normAcRm = norm(ac.room);
        const normStaffRm = norm(effectiveRm);
        rmMatch = (normStaffRm && (normAcRm === normStaffRm || normAcRm.includes(normStaffRm) || normStaffRm.includes(normAcRm)));
      }

      return rmMatch;
    });

    // Strictly return only matching units. Never fall back to all aircons across campus!
    return filtered;
  }
  function formatAcLocation(ac, isCompact = false) {
    if (!ac) return '';
    let bld = (ac.building || '').trim();
    let flr = (ac.floor || '').trim();
    let rm = (ac.room || '').trim();

    if (!bld && !flr && !rm) return 'Assigned Area';

    const titleCase = (s) => s.split(' ').map(w => (w.length > 0 && !/^[A-Z0-9-]+$/.test(w)) ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w).join(' ');

    bld = titleCase(bld);
    flr = titleCase(flr);
    rm = titleCase(rm);

    if (isCompact) {
      if (bld.split(' ').length > 1) {
        bld = bld.replace(/\s+Building$/i, '');
      }
      flr = flr.replace(/First Floor/i, '1st Flr')
        .replace(/Second Floor/i, '2nd Flr')
        .replace(/Third Floor/i, '3rd Flr')
        .replace(/Fourth Floor/i, '4th Flr')
        .replace(/Fifth Floor/i, '5th Flr')
        .replace(/Floor/i, 'Flr');
      rm = rm.replace(/Laboratory/i, 'Lab')
        .replace(/Administration/i, 'Admin')
        .replace(/Conference Room/i, 'Conf. Rm');
    }

    const parts = [];
    if (bld) parts.push(bld);
    if (flr) parts.push(flr);
    if (rm) parts.push(rm);

    return parts.join(' • ');
  }


  // Backwards-compatible proxy for aircons list
  const AIRCONS_DATABASE = new Proxy([], {
    get(target, prop) {
      const realAircons = getAirconsDatabase();
      if (prop === 'length') return realAircons.length;
      if (prop === 'find') return (...args) => realAircons.find(...args);
      if (prop === 'map') return (...args) => realAircons.map(...args);
      if (prop === 'filter') return (...args) => realAircons.filter(...args);
      if (prop === 'forEach') return (...args) => realAircons.forEach(...args);
      if (prop === Symbol.iterator) return realAircons[Symbol.iterator].bind(realAircons);
      if (typeof prop === 'symbol') return realAircons[prop];
      if (!isNaN(prop)) return realAircons[prop];
      return realAircons[prop];
    }
  });

  function getStaffList() {
    try {
      const stored = localStorage.getItem('ecoTrack_staff');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          return parsed.filter(s => s && s.name && !s.isArchived && s.status !== 'Archived' && !s.is_archived && !['Carlos Rivera', 'Maria Santos', 'Jose Reyes', 'Ana Cruz', 'Mark Villanueva'].includes(s.name) && !s.email?.includes('@ecotrack.local'));
        }
      }
    } catch (e) {
      console.warn('Error reading staff:', e);
    }
    return [];
  }

  function resolveStaffAvatar(s) {
    if (!s) return '';
    if (typeof s === 'string') {
      const staffList = getStaffList();
      const match = staffList.find(st => st && st.name && st.name.trim().toLowerCase() === s.trim().toLowerCase());
      if (match) s = match;
      else return '';
    }
    const candidates = [
      s.avatar,
      s.photo_url,
      s.avatar_url,
      s.image_url,
      s.image,
      s.photo,
      s.picture,
      s.profile_image,
      s.profile_image_url
    ];
    let raw = '';
    for (const c of candidates) {
      if (typeof c === 'string') {
        const t = c.trim();
        if (t && t.toLowerCase() !== 'custom' && t.toLowerCase() !== 'default' && t.toLowerCase() !== 'null' && t.toLowerCase() !== 'undefined') {
          raw = t;
          break;
        }
      }
    }
    if (raw.startsWith('storage://')) return resolvePhotoUrl(raw);
    if (raw.startsWith('data:') || raw.startsWith('http://') || raw.startsWith('https://')) {
      return raw;
    }
    const sb = getSb();
    if (sb && sb.storage && typeof sb.storage.from === 'function') {
      const parts = raw.split('/');
      if (parts.length > 1) {
        try {
          const { data } = sb.storage.from(parts[0]).getPublicUrl(parts.slice(1).join('/'));
          if (data && data.publicUrl) return data.publicUrl;
        } catch (_) { }
      }
      const candidateBuckets = ['avatars', 'photos', 'profiles', 'staff', 'images'];
      for (const b of candidateBuckets) {
        try {
          const { data } = sb.storage.from(b).getPublicUrl(raw);
          if (data && data.publicUrl) return data.publicUrl;
        } catch (_) { }
      }
    }
    return raw;
  }
  function resolveStaffLocation(s) {
    if (!s) return '';
    if (typeof s === 'string') {
      const staffList = getStaffList();
      const match = staffList.find(st => st && st.name && st.name.trim().toLowerCase() === s.trim().toLowerCase());
      if (match) s = match;
      else return '';
    }
    const canonical = resolveStaffHierarchy(s);
    if (canonical) return canonical.assignment;
    const bld = (s.building_name || s.buildingName || s.building || '').trim();
    const flr = (s.floor_name || s.floorName || s.floor || '').trim();
    const rm = (s.room_name || s.roomName || s.room || '').trim();

    const parts = [bld, flr, rm].filter(Boolean);
    let fullLoc = '';
    if (parts.length >= 2) {
      fullLoc = parts.join(' • ');
    } else if (s.assignment && s.assignment.includes('•')) {
      fullLoc = s.assignment.trim();
    } else if (parts.length > 0) {
      fullLoc = parts.join(' • ');
    } else if (s.assignment) {
      fullLoc = s.assignment.trim();
    }

    if (!fullLoc) return '';

    return fullLoc
      .split('•')
      .map(seg => seg.trim())
      .filter(Boolean)
      .map(seg => seg.replace(/\b([a-z])/g, c => c.toUpperCase()))
      .join(' • ');
  }

  async function fetchStaffFromSupabase() {
    const sb = getSb();
    if (sb) {
      try {
        let staffData = null;
        try {
          const fetchPromise = sb.rpc('ecotrack_admin_list_staff');
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Staff fetch timed out (2.5s)')), 2500)
          );
          const { data, error } = await Promise.race([fetchPromise, timeoutPromise]);
          if (!error && Array.isArray(data) && data.length > 0) {
            staffData = data;
          }
        } catch (_) {}

        if (!staffData) {
          const { data, error } = await sb.from('staff').select('*').order('name');
          if (!error && Array.isArray(data) && data.length > 0) {
            staffData = data;
          }
        }

        if (Array.isArray(staffData) && staffData.length > 0) {
          const activeStaff = staffData.filter(s => s && !s.is_archived && s.status !== 'Archived' && !s.isArchived);
          try {
            localStorage.setItem('ecoTrack_staff', JSON.stringify(staffData));
            if (typeof window.updateReportFilters === 'function') window.updateReportFilters();
            window.dispatchEvent(new CustomEvent('ecotrack:staff-updated', { detail: activeStaff }));
          } catch (e) { }
          return activeStaff;
        }
      } catch (e) { }
    }
    return getStaffList();
  }

  let _maintenanceRealtimeChannel = null;
  let _maintenanceRealtimeSubscribed = false;
  let _backgroundPollTimer = null;
  let _activeModalPollTimer = null;

  function startBackgroundMaintenancePolling() {
    if (_backgroundPollTimer) return;
    _backgroundPollTimer = setInterval(async () => {
      const sb = getSb();
      if (!sb || document.hidden) return;
      try {
        ensureReportReadSession(sb);
        const authVersion = reportAuthVersion;
        const readRevision = reportWriteRevision;
        const { data, error } = await readMaintenanceRows(sb);
        if (authVersion !== reportAuthVersion) return;
        if (!error && Array.isArray(data)) {
          const freshNormalized = mergeReportsSafely(data, _reportsCache, readRevision);
          const freshHash = JSON.stringify(freshNormalized.map(r => ({
            id: r.id,
            status: r.status,
            updated: r.updated,
            tasks: r.tasks?.map(t => ({ id: t.id, s: t.status, v: t.verified, r: t.repaired, n: t.notes }))
          })));
          const currentHash = JSON.stringify(_reportsCache.map(r => ({
            id: r.id,
            status: r.status,
            updated: r.updated,
            tasks: r.tasks?.map(t => ({ id: t.id, s: t.status, v: t.verified, r: t.repaired, n: t.notes }))
          })));

          if (freshHash !== currentHash) {
            console.log('[Maintenance Background Sync] Live update detected from Supabase!');
            _reportsCache = freshNormalized;
            try {
              localStorage.setItem('ecoTrack_maintenance_reports', JSON.stringify(_reportsCache));
            } catch (_) { }

            if (currentDetailId) {
              try { renderDetailModalContent(); } catch (_) { }
            }
            if (activeChecklistReportId) {
              try { renderCurrentChecklistItemModal(); } catch (_) { }
            }
            refreshPageReportsView();
            window.dispatchEvent(new CustomEvent('ecotrack:reports-updated', { detail: _reportsCache }));
          }
        }
      } catch (_) { }
    }, 20000);
  }

  // Refresh immediately when user returns to or focuses this window
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      fetchReportsFromSupabase(true).then(() => {
        if (currentDetailId) {
          try { renderDetailModalContent(); } catch (_) { }
        }
      });
    }
  });

  window.addEventListener('focus', () => {
    fetchReportsFromSupabase(true).then(() => {
      if (currentDetailId) {
        try { renderDetailModalContent(); } catch (_) { }
      }
    });
  });

  function setupMaintenanceRealtime() {
    const sb = getSb();
    if (!sb || typeof sb.channel !== 'function') return;

    if (_maintenanceRealtimeChannel && _maintenanceRealtimeSubscribed) return;

    if (_maintenanceRealtimeChannel) {
      try { sb.removeChannel(_maintenanceRealtimeChannel); } catch (_) { }
      _maintenanceRealtimeChannel = null;
      _maintenanceRealtimeSubscribed = false;
    }

    try {
      const chName = `maint_desktop_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      _maintenanceRealtimeChannel = sb.channel(chName)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'maintenance_reports' }, (payload) => {
          console.log('[Maintenance Realtime] postgres_changes event:', payload.eventType, payload.new ? payload.new.id : '');

          if (payload.new && payload.new.id) {
            const fresh = normalizeReport(payload.new);
            if (fresh) {
              const idx = _reportsCache.findIndex(r => String(r.id) === String(fresh.id));
              if (idx !== -1) {
                _reportsCache[idx] = fresh;
              } else {
                _reportsCache.unshift(fresh);
              }
              _reportsCache = syncReportsWithLinkedRepairs(_reportsCache);
              try {
                localStorage.setItem('ecoTrack_maintenance_reports', JSON.stringify(_reportsCache));
              } catch (_) { }

              if (currentDetailId && (String(currentDetailId) === String(fresh.id) || !currentDetailId)) {
                try { renderDetailModalContent(); } catch (err) { console.warn('[renderDetailModalContent realtime err]:', err); }
              }

              if (activeChecklistReportId && String(activeChecklistReportId) === String(fresh.id)) {
                try { renderCurrentChecklistItemModal(); } catch (err) { console.warn('[renderCurrentChecklistItemModal realtime err]:', err); }
              }

              if (activeRepairReportId && (String(activeRepairReportId) === String(fresh.id) || !activeRepairReportId)) {
                try { renderRepairTaskModalContent(fresh); } catch (err) { console.warn('[renderRepairTaskModalContent realtime err]:', err); }
              }

              refreshPageReportsView();
              window.dispatchEvent(new CustomEvent('ecotrack:reports-updated', { detail: _reportsCache }));
              broadcastMaintenanceChange('REALTIME_EVENT');
            }
          }

          fetchReportsFromSupabase(true).then(() => {
            if (currentDetailId) {
              try { renderDetailModalContent(); } catch (_) { }
            }
          });
        })
        .subscribe((status, err) => {
          console.log('[Maintenance Realtime] Channel status:', status, err || '');
          if (status === 'SUBSCRIBED') {
            _maintenanceRealtimeSubscribed = true;
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            _maintenanceRealtimeSubscribed = false;
            _maintenanceRealtimeChannel = null;
            setTimeout(setupMaintenanceRealtime, 3000);
          }
        });
    } catch (e) {
      console.warn('[setupMaintenanceRealtime error]:', e);
      _maintenanceRealtimeSubscribed = false;
      _maintenanceRealtimeChannel = null;
    }

    startBackgroundMaintenancePolling();
  }

  // ===================================================================
  // 2. CREATE REPORT MODAL & PRESETS (TYPES & DESCRIPTIONS)
  // ===================================================================

  const DEFAULT_MAINTENANCE_TYPES = [
    'Control Maintenance',
    'Control Inspection',
    'Control Calibration',
    'Control Replacement',
    'Aircon Cleaning',
    'Filter Cleaning',
    'Preventive Maintenance',
    'General Inspection',
    'Emergency Repair'
  ];

  function getDeletedTypes() {
    try {
      const stored = JSON.parse(localStorage.getItem('ecoTrack_deleted_types') || '[]');
      return Array.isArray(stored) ? stored : [];
    } catch (_) {
      return [];
    }
  }

  function getStandardTypes() {
    const deleted = getDeletedTypes();
    return DEFAULT_MAINTENANCE_TYPES.filter(t => !deleted.some(d => d.toLowerCase() === t.toLowerCase()));
  }

  function getCustomTypes() {
    try {
      const stored = JSON.parse(localStorage.getItem('ecoTrack_custom_types') || '[]');
      const deleted = getDeletedTypes();
      return (Array.isArray(stored) ? stored : []).filter(t => !deleted.some(d => d.toLowerCase() === t.toLowerCase()));
    } catch (_) {
      return [];
    }
  }

  function getAllMaintenanceTypes() {
    const all = [...getStandardTypes().map(type=>type==='Control Maintenance' && window.EcoTrackMode?.mode && window.EcoTrackMode.mode!=='controller' ? (window.EcoTrackMode.mode==='monitoring'?'Sensor Maintenance':'Device Maintenance') : type), ...getCustomTypes()];
    try {
      if (typeof createFormState !== 'undefined' && createFormState && createFormState.type && !all.some(t => t.toLowerCase() === createFormState.type.toLowerCase())) {
        all.unshift(createFormState.type);
      }
    } catch (_) { }
    return all.length > 0 ? all : ['Control Maintenance'];
  }

  function saveCustomType(typeName) {
    if (!typeName || !typeName.trim()) return;
    const trimmed = typeName.trim();
    // Un-delete if previously marked as deleted
    const deleted = getDeletedTypes().filter(t => t.toLowerCase() !== trimmed.toLowerCase());
    localStorage.setItem('ecoTrack_deleted_types', JSON.stringify(deleted));

    const list = getCustomTypes();
    if (!DEFAULT_MAINTENANCE_TYPES.some(t => t.toLowerCase() === trimmed.toLowerCase()) && !list.some(t => t.toLowerCase() === trimmed.toLowerCase())) {
      list.push(trimmed);
      localStorage.setItem('ecoTrack_custom_types', JSON.stringify(list));
    }
  }

  function deleteMaintenanceType(typeName) {
    if (!typeName) return;
    const trimmed = typeName.trim();
    const custom = getCustomTypes().filter(t => t.toLowerCase() !== trimmed.toLowerCase());
    localStorage.setItem('ecoTrack_custom_types', JSON.stringify(custom));

    const deleted = getDeletedTypes();
    if (!deleted.some(t => t.toLowerCase() === trimmed.toLowerCase())) {
      deleted.push(trimmed);
      localStorage.setItem('ecoTrack_deleted_types', JSON.stringify(deleted));
    }
  }

  const DEFAULT_MAINTENANCE_DESCRIPTIONS = [
    'Routine AC filter cleaning, deep coil wash, and airflow check',
    'Refrigerant pressure optimization and leak detection check',
    'Thermostat control calibration, ambient temperature audit, and telemetry check',
    'Electrical voltage inspection, capacitor testing, and wiring safety check',
    'Condensate drain pan flushing and anti-algae pipe clearing',
    'Fan motor servicing, bearing lubrication, and vibration dampening',
    'Emergency compressor diagnostic, contactor check, and thermal overload reset',
    'Preventive seasonal maintenance, multi-point diagnostic, and sanitization',
    'Environmental control node troubleshooting, battery inspection, and telemetry sync'
  ];

  function getDeletedDescriptions() {
    try {
      const stored = JSON.parse(localStorage.getItem('ecoTrack_deleted_descriptions') || '[]');
      return Array.isArray(stored) ? stored : [];
    } catch (_) {
      return [];
    }
  }

  function getStandardDescriptions() {
    const deleted = getDeletedDescriptions();
    return DEFAULT_MAINTENANCE_DESCRIPTIONS.filter(d => !deleted.includes(d));
  }

  function getCustomDescriptions() {
    try {
      const stored = JSON.parse(localStorage.getItem('ecoTrack_custom_descriptions') || '[]');
      const deleted = getDeletedDescriptions();
      return (Array.isArray(stored) ? stored : []).filter(d => !deleted.includes(d));
    } catch (_) {
      return [];
    }
  }

  function getAllDescriptionPresets() {
    return [...getStandardDescriptions(), ...getCustomDescriptions()];
  }

  function saveCustomDescription(desc) {
    if (!desc || !desc.trim()) return;
    const trimmed = desc.trim();
    const deleted = getDeletedDescriptions().filter(d => d !== trimmed);
    localStorage.setItem('ecoTrack_deleted_descriptions', JSON.stringify(deleted));

    const list = getCustomDescriptions();
    if (!DEFAULT_MAINTENANCE_DESCRIPTIONS.includes(trimmed) && !list.includes(trimmed)) {
      list.push(trimmed);
      localStorage.setItem('ecoTrack_custom_descriptions', JSON.stringify(list));
    }
  }

  function deleteDescriptionPreset(desc) {
    if (!desc) return;
    const custom = getCustomDescriptions().filter(d => d !== desc);
    localStorage.setItem('ecoTrack_custom_descriptions', JSON.stringify(custom));

    const deleted = getDeletedDescriptions();
    if (!deleted.includes(desc)) {
      deleted.push(desc);
      localStorage.setItem('ecoTrack_deleted_descriptions', JSON.stringify(deleted));
    }
  }

  let editingReportId = null;
  let editingReportVersion = null;

  const DEFAULT_CHECKLIST_TEMPLATES = [
    { name: 'Aircon Cleaning', selected: true },
    { name: 'Filter Cleaning', selected: true },
    { name: 'Temperature Control Inspection', selected: true },
    { name: 'Air Pressure Control Inspection', selected: true },
    { name: 'Energy Control Inspection', selected: true },
    { name: 'Control Calibration', selected: false },
    { name: 'Control Wiring Inspection', selected: false }
  ];

  function getActiveChecklistTemplates() {
    try {
      const stored = localStorage.getItem('ecoTrack_checklist_templates');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch (_) { }
    return DEFAULT_CHECKLIST_TEMPLATES.map(i => ({ ...i }));
  }

  function saveActiveChecklistTemplates(items) {
    try {
      localStorage.setItem('ecoTrack_checklist_templates', JSON.stringify(items));
    } catch (_) { }
  }

  var createFormState = {
    airconId: '',
    type: 'Control Maintenance',
    priority: 'High',
    dueDate: new Date(Date.now() + 86400000 * 2).toISOString().split('T')[0],
    staffName: '',
    staffId: '',
    description: '',
    airconType: 'Split Type (Inverter)',
    checklist: getActiveChecklistTemplates()
  };
  createFormState.type = getAllMaintenanceTypes()[0] || 'Control Maintenance';

  async function openCreateReportModal() {
    editingReportId = null;
    createFormState.type = getAllMaintenanceTypes()[0] || 'Control Maintenance';
    createFormState.priority = 'High';
    createFormState.dueDate = new Date(Date.now() + 86400000 * 2).toISOString().split('T')[0];
    createFormState.description = '';
    createFormState.checklist = getActiveChecklistTemplates();

    try {
      await Promise.all([
        fetchAirconsFromSupabase(),
        fetchStaffFromSupabase()
      ]);
    } catch (fetchErr) {
      console.warn('[openCreateReportModal] Supabase fetch error, continuing with local state:', fetchErr);
    }
    const staffList = getStaffList();
    if ((!createFormState.staffName || !staffList.some(s => s.name === createFormState.staffName)) && staffList.length > 0) {
      createFormState.staffName = staffList[0].name;
    }
    const currentStaff = staffList.find(s => s.id === createFormState.staffId) || staffList.find(s => s.name === createFormState.staffName) || staffList[0] || null;
    createFormState.staffId = currentStaff?.id || '';
    createFormState.staffName = currentStaff?.name || '';
    const allAircons = getAirconsDatabase();
    const staffAircons = getAirconsForStaff(currentStaff, allAircons);

    if (!staffAircons.some(a => a.id === createFormState.airconId)) {
      createFormState.airconId = staffAircons.length > 0 ? staffAircons[0].id : 'None';
    }
    const matchedAc = staffAircons.find(a => a.id === createFormState.airconId) || null;
    createFormState.airconType = matchedAc ? (matchedAc.brand || 'Split Type (Inverter)') : 'Split Type (Inverter)';

    let modal = document.getElementById('ecoCreateReportModal');
    if (!modal) {
      injectCreateModalHTML();
      modal = document.getElementById('ecoCreateReportModal');
    }
    renderCreateModalContent();
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }

  async function openEditReportModal(reportId) {
    if (!reportId) return;
    await Promise.all([
      fetchReportsFromSupabase(true),
      fetchAirconsFromSupabase(),
      fetchStaffFromSupabase()
    ]);
    const reports = getReports();
    const report = reports.find(r => r.id === reportId);
    if (!report) {
      showToast('Error', `Report ${reportId} not found.`, 'error');
      return;
    }

    const isRepReport = isActualRepairTask(report);
    

    if (isRepReport) {
      openEditRepairTaskModal(report.id);
      return;
    }



    editingReportId = report.id;
    editingReportVersion = report.updated || report.updated_at || reportVersions.get(report.id) || null;
    createFormState.airconId = report.airconId;
    createFormState.airconType = report.airconType || report.aircon_type || 'Split Type (Inverter)';
    createFormState.type = report.type || getAllMaintenanceTypes()[0] || 'Preventive Maintenance';
    createFormState.priority = report.priority || 'Medium';
    createFormState.dueDate = report.dueDate || new Date(Date.now() + 86400000 * 2).toISOString().split('T')[0];
    createFormState.staffName = report.staffName || '';
    createFormState.staffId = report.staff_id || report.staffId || '';
    createFormState.description = report.description || '';

    const baseTasks = [
      'Aircon Cleaning',
      'Filter Cleaning',
      'Temperature Control Inspection',
      'Air Pressure Control Inspection',
      'Energy Control Inspection',
      'Control Calibration',
      'Control Wiring Inspection'
    ];
    const existingTaskNames = (report.tasks || []).map(t => t.name);
    createFormState.checklist = baseTasks.map(name => ({
      name,
      selected: existingTaskNames.includes(name)
    }));
    (report.tasks || []).forEach(t => {
      if (!baseTasks.includes(t.name)) {
        createFormState.checklist.push({ name: t.name, selected: true });
      }
    });

    let modal = document.getElementById('ecoCreateReportModal');
    if (!modal) {
      injectCreateModalHTML();
      modal = document.getElementById('ecoCreateReportModal');
    }
    renderCreateModalContent();
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }

  function closeCreateReportModal() {
    const modal = document.getElementById('ecoCreateReportModal');
    if (modal) {
      modal.classList.add('hidden');
      modal.style.display = 'none';
      document.body.style.overflow = '';
    }
    refreshPageReportsView();
  }

  function injectCreateModalHTML() {
    if (document.getElementById('ecoCreateReportModal')) return;

    const modalHTML = `
      <div id="ecoCreateReportModal" class="hidden fixed inset-0 bg-slate-950/70 backdrop-blur-sm z-[9998] flex items-center justify-center p-3 sm:p-5">
        <div class="bg-white dark:bg-[#0c1328] border-2 border-gray-200 dark:border-[#10b981]/50 rounded-3xl w-full max-w-[980px] max-h-[90vh] shadow-2xl flex flex-col overflow-hidden text-gray-800 dark:text-gray-100 transition-colors">
          <!-- HEADER -->
          <div class="bg-white dark:bg-gradient-to-r dark:from-[#0b291d] dark:to-[#081a14] px-6 py-4 border-b border-gray-200 dark:border-[#10b981]/30 flex items-center justify-between shrink-0 transition-colors">
            <div class="flex items-center gap-3">
              <div id="ecoCreateModalIcon" class="w-10 h-10 rounded-xl bg-emerald-50 dark:bg-emerald-500/20 border border-emerald-500/30 dark:border-emerald-400/50 flex items-center justify-center text-[#10b981] dark:text-emerald-300 shadow-sm">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5">
                  <line x1="12" y1="5" x2="12" y2="19"></line>
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
              </div>
              <div>
                <h2 id="ecoCreateModalTitle" class="text-lg font-bold tracking-tight text-[#18392B] dark:text-cyan-400">Create Maintenance Report</h2>
                <p id="ecoCreateModalSubtitle" class="text-xs font-medium text-gray-500 dark:text-emerald-400/90">Assign technicians, inspect aircon telemetry, and set checklist milestones.</p>
              </div>
            </div>
            <button id="btnCloseCreateModal"
              class="w-8 h-8 rounded-full bg-gray-100 dark:bg-white/15 hover:bg-rose-50 dark:hover:bg-rose-500/30 text-gray-600 dark:text-white hover:text-rose-600 border border-gray-200 dark:border-white/25 flex items-center justify-center text-sm font-bold transition-all cursor-pointer shadow-sm">
              ✕
            </button>
          </div>

          <!-- BODY -->
          <div id="ecoCreateModalBody" class="p-5 overflow-y-auto flex-1 bg-gray-50 dark:bg-[#0a0f1d]/90 space-y-4 text-gray-800 dark:text-gray-100">
            <!-- Dynamically rendered -->
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHTML);

    document.getElementById('btnCloseCreateModal')?.addEventListener('click', closeCreateReportModal);
    const modal = document.getElementById('ecoCreateReportModal');
    modal?.addEventListener('click', (e) => {
      if (e.target === modal) closeCreateReportModal();
    });
  }

  function renderCreateModalContent() {
    const container = document.getElementById('ecoCreateModalBody');
    if (!container) return;

    // Preserve any current user input values before re-rendering
    const existingDesc = document.getElementById('modalCreateDesc');
    if (existingDesc && existingDesc.value !== undefined) {
      createFormState.description = existingDesc.value;
    }
    const existingDue = document.getElementById('modalCreateDueDate');
    if (existingDue && existingDue.value) {
      createFormState.dueDate = existingDue.value;
    }

    const staffList = getStaffList();
    const allAircons = getAirconsDatabase();
    const selectedStaff = staffList.find(s => s.id === createFormState.staffId) || staffList[0] || null;

    // Filter AC controls strictly to those matching technician's assigned area
    const aircons = getAirconsForStaff(selectedStaff, allAircons).slice();
    if (editingReportId) {
      const report = getReports().find(r => r.id === editingReportId);
      const originalAc = allAircons.find(a => a.id === report?.airconId);
      if (originalAc && !aircons.some(a => a.id === originalAc.id)) aircons.unshift(originalAc);
    }
    const staffBuildingName = getStaffBuilding(selectedStaff);
    const staffLocationDisplay = resolveStaffLocation(selectedStaff) || 'Assigned Area';

    let selectedAc = aircons.find(a => a.id === createFormState.airconId);
    if (!selectedAc && aircons.length > 0 && !editingReportId) {
      selectedAc = aircons[0];
      createFormState.airconId = selectedAc.id;
    }
    if (!selectedAc) {
      if (!editingReportId) createFormState.airconId = 'None';
      selectedAc = { id: createFormState.airconId, room: `AC unit unavailable in ${staffLocationDisplay}`, brand: 'N/A', model: 'N/A', state: 'Unavailable', controls: {} };
      if (editingReportId) aircons.unshift(selectedAc);
    }
    const selectedAcLoc = formatAcLocation(selectedAc, true);
    const selectedAcFullLoc = formatAcLocation(selectedAc, false);
    const activeReportForSelectedAc = findActiveUnverifiedReportForAircon(selectedAc.id, selectedAc.nodeId, editingReportId);

    const modalTitle = document.getElementById('ecoCreateModalTitle');
    const modalSubtitle = document.getElementById('ecoCreateModalSubtitle');
    const modalIcon = document.getElementById('ecoCreateModalIcon');
    if (modalTitle) {
      modalTitle.textContent = editingReportId ? 'Edit Maintenance Report' : 'Create Maintenance Report';
    }
    if (modalSubtitle) {
      modalSubtitle.innerHTML = editingReportId
        ? `Updating Report <strong class="text-[#10b981] dark:text-cyan-300 font-mono">${editingReportId}</strong>`
        : 'Assign technicians, inspect aircon telemetry, and set checklist milestones.';
    }
    if (modalIcon) {
      modalIcon.innerHTML = editingReportId
        ? `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`
        : `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`;
    }

    container.innerHTML = `
      <!-- INLINE VALIDATION ERROR BANNER -->
      <div id="modalFormErrorBanner" class="hidden modal-error-banner mb-4 relative overflow-hidden flex items-center justify-between gap-3 transition-all form-error-shake">
        <div class="flex items-center gap-3 min-w-0">
          <div class="error-icon-box w-8 h-8 rounded-xl flex items-center justify-center shrink-0">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="12"></line>
              <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
          </div>
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <p class="error-title leading-tight" id="modalFormErrorTitle">Description Required</p>
              <span id="modalFormErrorTimerBadge" class="error-timer-badge">5s</span>
            </div>
            <p class="error-desc mt-0.5 leading-snug" id="modalFormErrorText">Please select a preset template above or type detailed notes (minimum 5 characters).</p>
          </div>
        </div>
        <button type="button" id="btnDismissFormError" class="error-dismiss-btn shrink-0" title="Dismiss error">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
        <!-- Animated countdown progress bar -->
        <div id="modalFormErrorProgressBar" class="error-progress-bar"></div>
      </div>

      <!-- SECTION 1: AC CONTROL & AIRCON INFORMATION -->
      <div class="bg-white dark:bg-slate-900/70 border border-gray-200 dark:border-[#10b981]/30 rounded-2xl p-4 shadow-sm">
        <div class="flex items-center justify-between mb-3">
          <label class="text-xs font-bold text-[#18392B] dark:text-cyan-300 uppercase tracking-wider flex items-center gap-2">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" class="text-[#10b981]">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
              <line x1="8" y1="21" x2="16" y2="21"></line>
              <line x1="12" y1="17" x2="12" y2="21"></line>
            </svg>
            ${maintenanceDeviceLabel()} & Aircon Information <span class="text-rose-500">*</span>
          </label>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
          <div class="relative">
            <label class="block text-[11px] font-bold text-gray-600 dark:text-gray-400 mb-1.5 uppercase tracking-wider">
              ${maintenanceDeviceLabel()} Name
              ${staffBuildingName ? `
                <span class="text-[10px] font-semibold text-[#10b981] dark:text-emerald-400 normal-case ml-1.5 font-sans tracking-normal bg-emerald-50 dark:bg-emerald-950/60 px-2 py-0.5 rounded-md border border-emerald-500/20">📍 ${staffBuildingName.toLowerCase().includes('all') ? 'All Buildings (Campus-Wide)' : staffBuildingName.replace(/\b([a-z])/g, c => c.toUpperCase())}</span>
              ` : ''}
            </label>
            
            <button type="button" id="modalAirconDropdownTrigger"
              class="w-full bg-white dark:bg-[#0c1328] border-2 border-gray-300 dark:border-[#10b981]/50 text-gray-800 dark:text-white rounded-xl px-3 py-2 text-xs font-bold focus:outline-none focus:border-[#10b981] dark:focus:border-cyan-400 cursor-pointer shadow-sm flex items-center justify-between hover:border-[#10b981] transition-all"
              aria-haspopup="listbox" aria-expanded="false">
              <div class="flex items-center gap-2 truncate min-w-0" title="${maintenanceDisplayText(maintenanceControllerName(selectedAc))} — ${selectedAcFullLoc}">
                <span class="w-2 h-2 rounded-full ${selectedAc.state === 'Needs Repair' ? 'bg-rose-500' : selectedAc.state === 'Online' ? 'bg-emerald-400' : 'bg-slate-400'} shrink-0"></span>
                <span class="truncate font-bold text-xs">${maintenanceDisplayText(maintenanceControllerName(selectedAc))} — ${selectedAcLoc}</span>
              </div>
              <svg class="w-4 h-4 text-gray-400 dark:text-[#10b981] transition-transform duration-200 shrink-0 ml-1.5" id="modalAirconDropdownArrow" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd"/>
              </svg>
            </button>

            <select id="modalCreateAirconSelect" class="sr-only hidden" tabindex="-1" aria-hidden="true">
              ${aircons.map(ac => `
                <option value="${ac.id}" ${ac.id === selectedAc.id ? 'selected' : ''}>
                  ${maintenanceDisplayText(maintenanceControllerName(ac))} — ${formatAcLocation(ac, false)} (${ac.brand})
                </option>
              `).join('')}
            </select>

            <div id="modalAirconDropdownMenu"
              class="hidden absolute left-0 right-0 top-full mt-1.5 z-50 bg-white dark:bg-[#0c1328] border-2 border-gray-200 dark:border-[#10b981]/60 rounded-xl shadow-2xl dark:shadow-[0_12px_32px_rgba(0,0,0,0.85)] max-h-56 overflow-y-auto p-1.5 space-y-1 custom-dropdown-menu">
              ${aircons.length > 0 ? aircons.map(ac => {
      const isSelected = ac.id === selectedAc.id;
      const isWarning = ac.state === 'Needs Repair';
      const acActive = findActiveUnverifiedReportForAircon(ac.id, ac.nodeId, editingReportId);
      const acLoc = formatAcLocation(ac, true);
      const acFull = formatAcLocation(ac, false);
      return `
                  <div class="custom-aircon-item flex items-center justify-between px-2.5 py-2 rounded-lg cursor-pointer transition-all duration-150 ${isSelected ? 'bg-emerald-50 dark:bg-[#10b981]/25 text-[#18392B] dark:text-emerald-300 font-bold border border-emerald-500/30' : 'text-gray-700 dark:text-gray-200 hover:bg-emerald-50 dark:hover:bg-[#10b981]/15 hover:text-[#10b981] dark:hover:text-emerald-300'}"
                       data-aircon-id="${ac.id}">
                    <div class="min-w-0 flex-1 mr-2">
                      <div class="flex items-center gap-1.5">
                        <span class="w-1.5 h-1.5 rounded-full ${isWarning ? 'bg-rose-500' : (acActive ? 'bg-amber-400 animate-pulse' : ac.state === 'Online' ? 'bg-emerald-400' : 'bg-slate-400')} shrink-0"></span>
                        <span class="text-xs font-bold truncate">${maintenanceDisplayText(maintenanceControllerName(ac))}</span>
                        ${acActive ? `<span class="px-1.5 py-0.2 rounded text-[9px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 shrink-0">Active: ${acActive.status}</span>` : ''}
                      </div>
                      <div class="text-[10px] font-semibold text-emerald-700 dark:text-emerald-400 truncate mt-0.5" title="${acFull}">
                        📍 ${acLoc}
                      </div>
                      <div class="text-[9.5px] text-gray-500 dark:text-gray-400 truncate mt-0.5">
                        ${ac.brand || 'Split Type (Inverter)'}
                      </div>
                    </div>
                    <div class="flex items-center gap-1.5 shrink-0">
                      <span class="px-2 py-0.5 text-[9px] font-extrabold rounded-full border ${isWarning ? 'bg-rose-100 dark:bg-rose-950/80 text-rose-700 dark:text-rose-300 border-rose-400/40' : maintenanceStateClasses(ac.state)}">
                        ${ac.state || 'Unavailable'}
                      </span>
                      ${isSelected ? `
                        <svg class="w-3.5 h-3.5 text-[#10b981] dark:text-emerald-400 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                          <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                        </svg>
                      ` : ''}
                    </div>
                  </div>
                `;
    }).join('') : `
      <div class="px-3 py-4 text-center">
        <p class="text-xs font-bold text-amber-500 dark:text-amber-400 mb-1">⚠️ No Assigned AC Units Found</p>
        <p class="text-[11px] text-gray-500 dark:text-gray-400 leading-snug">
          ${selectedStaff?.name || 'Technician'} is assigned to <strong class="text-gray-700 dark:text-gray-200">${staffLocationDisplay}</strong>, which currently has no AC controls installed.
        </p>
      </div>
    `}
            </div>
          </div>

          <div class="md:col-span-2">
            <label class="block text-[11px] font-bold text-gray-600 dark:text-gray-400 mb-1.5 uppercase tracking-wider">${maintenanceDeviceLabel()} & Aircon Details</label>
            <div class="bg-emerald-50/70 dark:bg-[#081a14] border border-emerald-500/30 dark:border-[#10b981]/40 rounded-xl p-3 flex flex-col gap-2 shadow-sm">
              <div class="flex items-center justify-between border-b border-gray-200 dark:border-white/10 pb-1.5">
                <div class="min-w-0 flex-1 mr-2">
                  <span class="text-xs font-bold text-[#18392B] dark:text-cyan-300">${maintenanceDeviceLabel()}: ${maintenanceDisplayText(maintenanceControllerName(selectedAc))}</span>
                  <span class="text-xs text-gray-600 dark:text-gray-400 ml-2 font-medium truncate" title="${selectedAcFullLoc}">• 📍 ${selectedAcLoc}</span>
                </div>
                <span class="px-2 py-0.5 text-[10px] font-extrabold rounded-full border ${maintenanceStateClasses(selectedAc.state)}">
                  ${selectedAc.state || 'Unavailable'}
                </span>
              </div>
              <div class="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                <div>
                  <span class="text-[10px] text-gray-500 dark:text-gray-400 block uppercase">Type of Aircon</span>
                  <span class="font-semibold text-gray-800 dark:text-gray-200 text-[11px]">${selectedAc.brand || 'Split Type (Inverter)'}</span>
                </div>
                <div>
                  <span class="text-[10px] text-gray-500 dark:text-gray-400 block uppercase">${maintenanceDeviceLabel()} Name</span>
                  <span data-maintenance-controller-name class="font-semibold text-gray-800 dark:text-gray-200 text-[11px] break-words">${maintenanceDisplayText(maintenanceControllerName(selectedAc))}</span>
                </div>
                <div>
                  <span class="text-[10px] text-gray-500 dark:text-gray-400 block uppercase mb-1">${maintenanceDeviceLabel()} Diagnostics</span>
                  <div class="flex flex-wrap gap-1.5" aria-label="${maintenanceDeviceLabel()} diagnostic readings">
                    ${renderMaintenanceDiagnostics(selectedAc)}
                  </div>
                </div>
              </div>

              ${activeReportForSelectedAc ? `
                <!-- ACTIVE UNVERIFIED REPORT IN-PROGRESS WARNING (HIGH CONTRAST) -->
                <div class="mt-2.5 p-3 rounded-xl bg-amber-50 dark:bg-amber-950/80 border-2 border-amber-400 dark:border-amber-500/70 text-gray-900 dark:text-amber-100 flex items-center justify-between gap-3 shadow-md">
                  <div class="flex items-center gap-3 min-w-0">
                    <div class="w-7 h-7 rounded-lg bg-amber-500/20 dark:bg-amber-500/30 text-amber-700 dark:text-amber-300 flex items-center justify-center shrink-0 border border-amber-500/40">
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5">
                        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                        <line x1="12" y1="9" x2="12" y2="13"></line>
                        <line x1="12" y1="17" x2="12.01" y2="17"></line>
                      </svg>
                    </div>
                    <div class="min-w-0">
                      <p class="font-extrabold text-xs text-amber-900 dark:text-amber-300 leading-tight">
                        Active Report in Progress <span class="font-mono text-amber-800 dark:text-amber-200">(${activeReportForSelectedAc.id})</span>
                      </p>
                      <p class="text-[11px] font-semibold text-amber-800/90 dark:text-amber-200/90 leading-tight mt-0.5">
                        Current status is <span class="font-bold underline text-amber-950 dark:text-amber-100">"${activeReportForSelectedAc.status}"</span>. Creating another report for this unit is halted until verified.
                      </p>
                    </div>
                  </div>
                  <span class="px-2.5 py-1 rounded-lg text-[10px] font-black bg-amber-500 text-slate-950 dark:bg-amber-400 dark:text-slate-950 border border-amber-600/40 uppercase tracking-wider shrink-0 shadow-sm">
                    ${activeReportForSelectedAc.status}
                  </span>
                </div>
              ` : ''}
            </div>
          </div>
        </div>
      </div>

      <!-- SECTION 2: TYPE, PRIORITY, DUE DATE -->
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div class="relative bg-white dark:bg-slate-900/70 border border-gray-200 dark:border-white/10 rounded-xl p-3 shadow-sm">
          <div class="flex items-center justify-between mb-1.5">
            <label class="block text-[11px] font-bold text-gray-600 dark:text-gray-300 uppercase tracking-wider">Maintenance Type</label>
            <button type="button" id="btnToggleAddTypeDirect" class="text-[10px] font-bold text-[#10b981] dark:text-emerald-400 hover:underline bg-transparent border-0 cursor-pointer p-0" title="Click to type a custom maintenance type">+ Type New</button>
          </div>
          <button type="button" id="modalTypeDropdownTrigger"
            class="w-full bg-white dark:bg-[#0c1328] border-2 border-gray-300 dark:border-[#10b981]/50 text-gray-800 dark:text-white rounded-xl px-3 py-2 text-xs font-bold focus:outline-none focus:border-[#10b981] dark:focus:border-cyan-400 cursor-pointer shadow-sm flex items-center justify-between hover:border-[#10b981] transition-all"
            aria-haspopup="listbox" aria-expanded="false">
            <span class="truncate">${createFormState.type}</span>
            <svg class="w-4 h-4 text-gray-400 dark:text-[#10b981] transition-transform duration-200 shrink-0 ml-1.5" id="modalTypeDropdownArrow" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd"/>
            </svg>
          </button>
          <select id="modalCreateType" class="sr-only hidden" tabindex="-1" aria-hidden="true">
            ${getAllMaintenanceTypes().map(t => `<option value="${t}" ${createFormState.type === t ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
          <div id="modalTypeDropdownMenu"
            class="hidden absolute left-0 right-0 top-full mt-1.5 z-50 bg-white dark:bg-[#0c1328] border-2 border-gray-200 dark:border-[#10b981]/60 rounded-xl shadow-2xl dark:shadow-[0_12px_32px_rgba(0,0,0,0.85)] max-h-64 overflow-hidden flex flex-col custom-dropdown-menu">
            <!-- Quick-Type / Add Input Header -->
            <div class="p-2 border-b border-gray-200 dark:border-white/10 bg-gray-50/90 dark:bg-[#081a14]/90 shrink-0">
              <div class="flex items-center gap-1.5">
                <input type="text" id="modalNewTypeInput" placeholder="Type new maintenance type..."
                  class="flex-1 bg-white dark:bg-[#060b18] border border-gray-300 dark:border-white/20 text-gray-800 dark:text-white rounded-lg px-2.5 py-1.5 text-xs font-semibold focus:outline-none focus:border-[#10b981] placeholder-gray-400"
                  autocomplete="off">
                <button type="button" id="modalBtnAddNewType"
                  class="px-2.5 py-1.5 bg-[#10b981] hover:bg-emerald-400 text-slate-950 font-bold text-xs rounded-lg transition-all border-0 cursor-pointer shrink-0 flex items-center gap-1 shadow-sm"
                  title="Add this typed type">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3">
                    <line x1="12" y1="5" x2="12" y2="19"></line>
                    <line x1="5" y1="12" x2="19" y2="12"></line>
                  </svg>
                  <span>Add</span>
                </button>
              </div>
            </div>

            <!-- List of Types with Delete buttons -->
            <div class="overflow-y-auto p-1.5 space-y-1 flex-1 max-h-48" id="modalTypeListContainer">
              ${getAllMaintenanceTypes().map(t => {
                const isSel = createFormState.type === t;
                return `
                  <div class="custom-type-item group flex items-center justify-between px-2.5 py-1.5 rounded-lg cursor-pointer transition-all duration-150 ${isSel ? 'bg-emerald-50 dark:bg-[#10b981]/25 text-[#18392B] dark:text-emerald-300 font-bold border border-emerald-500/30' : 'text-gray-700 dark:text-gray-200 hover:bg-emerald-50 dark:hover:bg-[#10b981]/15 hover:text-[#10b981] dark:hover:text-emerald-300'}"
                       data-type-val="${t}">
                    <span class="text-xs truncate flex-1 mr-2 ${isSel ? 'font-bold' : 'font-medium'}">${t}</span>
                    <div class="flex items-center gap-1.5 shrink-0">
                      ${isSel ? `
                        <svg class="w-3.5 h-3.5 text-[#10b981] dark:text-emerald-400 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                          <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                        </svg>
                      ` : ''}
                      <button type="button" class="btn-delete-type opacity-40 group-hover:opacity-100 hover:bg-rose-100 dark:hover:bg-rose-950/80 text-gray-400 hover:text-rose-600 dark:hover:text-rose-400 p-1 rounded-md transition-all shrink-0"
                              title="Delete maintenance type" data-delete-type="${t}">
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <polyline points="3 6 5 6 21 6"></polyline>
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                          <line x1="10" y1="11" x2="10" y2="17"></line>
                          <line x1="14" y1="11" x2="14" y2="17"></line>
                        </svg>
                      </button>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        </div>

        <div class="relative bg-white dark:bg-slate-900/70 border border-gray-200 dark:border-white/10 rounded-xl p-3 shadow-sm">
          <label class="block text-[11px] font-bold text-gray-600 dark:text-gray-300 mb-1.5 uppercase tracking-wider">Priority</label>
          <button type="button" id="modalPriorityDropdownTrigger"
            class="w-full bg-white dark:bg-[#0c1328] border-2 border-gray-300 dark:border-[#10b981]/50 text-gray-800 dark:text-white rounded-xl px-3 py-2 text-xs font-bold focus:outline-none focus:border-[#10b981] dark:focus:border-cyan-400 cursor-pointer shadow-sm flex items-center justify-between hover:border-[#10b981] transition-all"
            aria-haspopup="listbox" aria-expanded="false">
            <div class="flex items-center gap-2 truncate">
              <span class="w-2 h-2 rounded-full ${createFormState.priority === 'Critical' ? 'bg-rose-500 shadow-[0_0_6px_rgba(244,63,94,0.6)]' : (createFormState.priority === 'High' ? 'bg-amber-500' : (createFormState.priority === 'Medium' ? 'bg-sky-500' : 'bg-emerald-500'))} shrink-0"></span>
              <span>${createFormState.priority || 'Low'}</span>
            </div>
            <svg class="w-4 h-4 text-gray-400 dark:text-[#10b981] transition-transform duration-200 shrink-0 ml-1.5" id="modalPriorityDropdownArrow" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd"/>
            </svg>
          </button>
          <select id="modalCreatePriority" class="sr-only hidden" tabindex="-1" aria-hidden="true">
            <option value="Low" ${createFormState.priority === 'Low' ? 'selected' : ''}>Low</option>
            <option value="Medium" ${createFormState.priority === 'Medium' ? 'selected' : ''}>Medium</option>
            <option value="High" ${createFormState.priority === 'High' ? 'selected' : ''}>High</option>
            <option value="Critical" ${createFormState.priority === 'Critical' ? 'selected' : ''}>Critical</option>
          </select>
          <div id="modalPriorityDropdownMenu"
            class="hidden absolute left-3 right-3 top-full mt-1.5 z-50 bg-white dark:bg-[#0c1328] border-2 border-gray-200 dark:border-[#10b981]/60 rounded-xl shadow-2xl dark:shadow-[0_12px_32px_rgba(0,0,0,0.85)] max-h-56 overflow-y-auto p-1.5 space-y-1 custom-dropdown-menu">
            ${[
        { val: 'Low', color: 'bg-emerald-500', sub: 'Standard / Routine' },
        { val: 'Medium', color: 'bg-sky-500', sub: 'Normal Monitoring' },
        { val: 'High', color: 'bg-amber-500', sub: 'Action Required' },
        { val: 'Critical', color: 'bg-rose-500', sub: 'Urgent Dispatch' }
      ].map(p => {
        const isSel = createFormState.priority === p.val;
        return `
                <div class="custom-priority-item flex items-center justify-between px-2.5 py-1.5 rounded-lg cursor-pointer transition-all duration-150 ${isSel ? 'bg-emerald-50 dark:bg-[#10b981]/25 text-[#18392B] dark:text-emerald-300 font-bold border border-emerald-500/30' : 'text-gray-700 dark:text-gray-200 hover:bg-emerald-50 dark:hover:bg-[#10b981]/15 hover:text-[#10b981] dark:hover:text-emerald-300'}"
                     data-priority-val="${p.val}">
                  <div class="flex items-center gap-2">
                    <span class="w-2 h-2 rounded-full ${p.color} shrink-0"></span>
                    <div>
                      <span class="text-xs font-bold">${p.val}</span>
                      <span class="text-[10px] text-gray-500 dark:text-gray-400 block">${p.sub}</span>
                    </div>
                  </div>
                  ${isSel ? `
                    <svg class="w-3.5 h-3.5 text-[#10b981] dark:text-emerald-400" viewBox="0 0 20 20" fill="currentColor">
                      <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                    </svg>
                  ` : ''}
                </div>
              `;
      }).join('')}
          </div>
        </div>

        <div class="bg-white dark:bg-slate-900/70 border border-gray-200 dark:border-white/10 rounded-xl p-3 shadow-sm">
          <label class="block text-[11px] font-bold text-gray-600 dark:text-gray-300 mb-1.5 uppercase tracking-wider">Due Date <span class="text-rose-500">*</span></label>
          <input type="date" id="modalCreateDueDate" value="${createFormState.dueDate}"
            min="${new Date().toISOString().split('T')[0]}"
            class="w-full bg-white dark:bg-[#0c1328] border-2 border-gray-300 dark:border-[#10b981]/50 text-gray-800 dark:text-white rounded-xl px-3 py-2 text-xs font-bold focus:outline-none focus:border-[#10b981] dark:focus:border-cyan-400 shadow-sm">
        </div>
      </div>

      <!-- SECTION 3: ASSIGN MAINTENANCE STAFF -->
      <div class="bg-white dark:bg-slate-900/70 border border-gray-200 dark:border-[#10b981]/30 rounded-2xl p-4 shadow-sm">
        <div class="flex items-center justify-between mb-3">
          <label class="text-xs font-bold text-[#18392B] dark:text-cyan-300 uppercase tracking-wider flex items-center gap-2">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" class="text-[#10b981]">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
              <circle cx="9" cy="7" r="4"></circle>
            </svg>
            Assign Maintenance Staff
          </label>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
          <div class="relative">
            <label class="block text-[11px] font-bold text-gray-600 dark:text-gray-400 mb-1.5 uppercase tracking-wider">Technician <span class="text-rose-500">*</span></label>
            <button type="button" id="modalStaffDropdownTrigger"
              class="w-full bg-white dark:bg-[#0c1328] border-2 border-gray-300 dark:border-[#10b981]/50 text-gray-800 dark:text-white rounded-xl px-3 py-2 text-xs font-bold focus:outline-none focus:border-[#10b981] dark:focus:border-cyan-400 cursor-pointer shadow-sm flex items-center justify-between hover:border-[#10b981] transition-all"
              aria-haspopup="listbox" aria-expanded="false">
              <div class="flex items-center gap-2 truncate">
                <span class="w-2 h-2 rounded-full ${selectedStaff && (selectedStaff.status === 'Active' || selectedStaff.status === 'Online' || selectedStaff.is_online) ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]' : 'bg-gray-400'} shrink-0"></span>
                <span class="truncate">${selectedStaff ? `${selectedStaff.name} (${selectedStaff.status || (selectedStaff.is_online ? 'Active' : 'Offline')})` : 'No technicians registered'}</span>
              </div>
              <svg class="w-4 h-4 text-gray-400 dark:text-[#10b981] transition-transform duration-200 shrink-0 ml-1.5" id="modalStaffDropdownArrow" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd"/>
              </svg>
            </button>
            <select id="modalCreateStaffSelect" class="sr-only hidden" tabindex="-1" aria-hidden="true">
              ${staffList.length > 0 ? staffList.map(s => `
                <option value="${s.id}" ${selectedStaff && s.id === selectedStaff.id ? 'selected' : ''}>
                  ${s.name} (${s.status || 'Active'})
                </option>
              `).join('') : '<option value="">No technicians registered</option>'}
            </select>
            <div id="modalStaffDropdownMenu"
              class="hidden absolute left-0 right-0 top-full mt-1.5 z-50 bg-white dark:bg-[#0c1328] border-2 border-gray-200 dark:border-[#10b981]/60 rounded-xl shadow-2xl dark:shadow-[0_12px_32px_rgba(0,0,0,0.85)] max-h-56 overflow-y-auto p-1.5 space-y-1 custom-dropdown-menu">
              ${staffList.length > 0 ? staffList.map(s => {
        const isSelected = selectedStaff && s.id === selectedStaff.id;
        const isOnline = s.status === 'Active' || s.status === 'Online' || s.is_online;
        const photoSrc = resolveStaffAvatar(s);
        const initials = (s.name || 'ST').split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
        return `
                  <div class="custom-staff-item flex items-center justify-between px-2.5 py-2 rounded-lg cursor-pointer transition-all duration-150 ${isSelected ? 'bg-emerald-50 dark:bg-[#10b981]/25 text-[#18392B] dark:text-emerald-300 font-bold border border-emerald-500/30' : 'text-gray-700 dark:text-gray-200 hover:bg-emerald-50 dark:hover:bg-[#10b981]/15 hover:text-[#10b981] dark:hover:text-emerald-300'}"
                       data-staff-name="${s.name}" data-staff-id="${s.id}">
                    <div class="flex items-center gap-2.5 min-w-0">
                      <div class="w-7 h-7 rounded-full overflow-hidden border border-[#10b981]/50 bg-emerald-100 dark:bg-emerald-950 flex items-center justify-center font-bold text-[10px] text-[#10b981] shrink-0 shadow-sm">
                        ${photoSrc ? `
                          <img src="${photoSrc}" alt="${s.name}" class="w-full h-full object-cover" onerror="this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.style.display='flex';">
                          <span style="display:none;" class="w-full h-full flex items-center justify-center font-bold text-[10px] text-[#10b981]">${initials}</span>
                        ` : `
                          <span>${initials}</span>
                        `}
                      </div>
                      <div class="min-w-0">
                        <div class="text-xs font-bold truncate leading-tight">${s.name}</div>
                        <div class="text-[10px] text-gray-500 dark:text-gray-400 truncate leading-tight">${s.role || 'HVAC / Aircon Technician'}</div>
                        ${(() => {
            const sLoc = resolveStaffLocation(s);
            return sLoc ? `<div class="text-[9.5px] text-[#10b981] dark:text-emerald-400 truncate leading-tight mt-0.5">📍 ${sLoc}</div>` : '';
          })()}
                      </div>
                    </div>
                    <div class="flex items-center gap-1.5 shrink-0 ml-2">
                      <span class="px-2 py-0.5 text-[9px] font-bold rounded-full ${isOnline ? 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 border border-emerald-400/30' : 'bg-gray-100 dark:bg-slate-800 text-gray-500 dark:text-gray-400 border border-gray-300 dark:border-white/10'}">
                        ${s.status || (isOnline ? 'Active' : 'Offline')}
                      </span>
                      ${isSelected ? `
                        <svg class="w-3.5 h-3.5 text-[#10b981] dark:text-emerald-400" viewBox="0 0 20 20" fill="currentColor">
                          <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                        </svg>
                      ` : ''}
                    </div>
                  </div>
                `;
      }).join('') : `
                <div class="p-3 text-center text-xs text-gray-400 italic">No technicians registered</div>
              `}
            </div>
          </div>

          <div class="md:col-span-2">
            <label class="block text-[11px] font-bold text-gray-600 dark:text-gray-400 mb-1.5 uppercase tracking-wider">Staff Profile Preview</label>
            <div class="bg-emerald-50/70 dark:bg-[#081a14] border border-emerald-500/30 dark:border-[#10b981]/40 rounded-xl p-3 flex items-center justify-between gap-3 shadow-sm min-h-[46px]">
              ${selectedStaff ? (() => {
        const previewPhoto = resolveStaffAvatar(selectedStaff);
        const initials = (selectedStaff.name || 'ST').split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
        return `
                <div class="flex items-center gap-3">
                  <div class="w-11 h-11 rounded-full overflow-hidden border-2 border-[#10b981] bg-emerald-100 dark:bg-emerald-950 flex items-center justify-center font-bold text-xs text-[#10b981] shrink-0 shadow-sm">
                    ${previewPhoto ? `
                      <img src="${previewPhoto}" alt="${selectedStaff.name}" class="w-full h-full object-cover" onerror="this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.style.display='flex';">
                      <span style="display:none;" class="w-full h-full flex items-center justify-center font-bold text-xs text-[#10b981]">${initials}</span>
                    ` : `
                      <span class="font-bold text-xs text-[#10b981]">${initials}</span>
                    `}
                  </div>
                  <div class="min-w-0">
                    <h4 class="font-bold text-xs text-gray-800 dark:text-white truncate">${selectedStaff.name}</h4>
                    <p class="text-[11px] text-gray-500 dark:text-gray-400 font-medium">${selectedStaff.role || 'HVAC / Aircon Technician'} • ${selectedStaff.phone || selectedStaff.email || 'Registered Staff'}</p>
                    ${(() => {
            const staffLoc = resolveStaffLocation(selectedStaff);
            return staffLoc ? `
                        <span class="text-[10px] text-[#10b981] dark:text-emerald-400 font-semibold block mt-0.5 truncate">📍 ${staffLoc}</span>
                      ` : '';
          })()}
                  </div>
                </div>
                <div class="text-right text-xs shrink-0">
                  <span class="text-[10px] text-gray-500 dark:text-gray-400 block uppercase font-bold mb-0.5">Status</span>
                  <span class="px-2.5 py-0.5 text-[10px] font-bold rounded-full ${selectedStaff.status === 'Active' || selectedStaff.status === 'Online' || selectedStaff.is_online ? 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 border border-emerald-400/40' : 'bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-gray-400 border border-gray-300 dark:border-white/10'}">
                    ${selectedStaff.status || (selectedStaff.is_online ? 'Active' : 'Offline')}
                  </span>
                </div>
              `})() : `
                <div class="flex items-center gap-2.5 text-gray-400">
                  <span class="text-xs italic">No registered maintenance staff found. Please register staff in Staff Directory.</span>
                </div>
              `}
            </div>
          </div>
        </div>
      </div>

      <!-- SECTION 4: MAINTENANCE DESCRIPTION (DROPDOWN + ADD NEW + CUSTOM NOTES) -->
      <div class="bg-white dark:bg-slate-900/70 border border-gray-200 dark:border-[#10b981]/30 rounded-2xl p-4 shadow-sm space-y-3">
        <div class="flex items-center justify-between">
          <label class="text-xs font-bold text-[#18392B] dark:text-cyan-300 uppercase tracking-wider flex items-center gap-2">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" class="text-[#10b981]">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
              <line x1="16" y1="13" x2="8" y2="13"></line>
              <line x1="16" y1="17" x2="8" y2="17"></line>
              <polyline points="10 9 9 9 8 9"></polyline>
            </svg>
            Maintenance Description
          </label>
        </div>

        <div class="relative">
          <label class="block text-[11px] font-bold text-gray-600 dark:text-gray-400 mb-1.5 uppercase tracking-wider">Select Standard or Custom Description</label>
          <button type="button" id="modalDescPresetDropdownTrigger"
            class="w-full bg-white dark:bg-[#0c1328] border-2 border-gray-200 dark:border-[#10b981]/40 text-gray-800 dark:text-gray-100 rounded-xl px-3.5 py-2.5 text-xs font-semibold focus:outline-none focus:border-[#10b981] dark:focus:border-[#10b981] cursor-pointer shadow-sm flex items-center justify-between hover:border-[#10b981] transition-colors text-left"
            aria-haspopup="listbox" aria-expanded="false">
            <span class="truncate">${createFormState.description ? createFormState.description : '— Select Description Template / Preset —'}</span>
            <div class="pointer-events-none flex items-center px-1 text-emerald-600 dark:text-[#10b981] shrink-0">
              <svg id="modalDescPresetDropdownArrow" class="transition-transform duration-200" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="6 9 12 15 18 9"></polyline>
              </svg>
            </div>
          </button>
          
          <select id="modalDescPresetSelect" class="sr-only hidden" tabindex="-1" aria-hidden="true">
            <option value="">– Select Description Template / Preset –</option>
            ${getStandardDescriptions().map(d => `<option value="${d}" ${createFormState.description === d ? 'selected' : ''}>${d}</option>`).join('')}
            ${getCustomDescriptions().map(d => `<option value="${d}" ${createFormState.description === d ? 'selected' : ''}>${d}</option>`).join('')}
            <option value="__NEW_OPTION__">+ Add New Custom Description...</option>
          </select>

          <div id="modalDescPresetDropdownMenu"
            class="hidden absolute left-0 right-0 top-full mt-1.5 z-50 bg-white dark:bg-[#0c1328] border-2 border-gray-200 dark:border-[#10b981]/60 rounded-xl shadow-2xl dark:shadow-[0_12px_32px_rgba(0,0,0,0.85)] max-h-60 overflow-y-auto p-1.5 space-y-1 custom-dropdown-menu">
            ${getStandardDescriptions().length > 0 ? `
            <div class="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-emerald-800 dark:text-emerald-400 bg-emerald-50/50 dark:bg-[#081a14]/60 rounded flex items-center justify-between">
              <span>Standard Maintenance Presets</span>
              <span class="text-[9px] font-medium text-gray-500 dark:text-gray-400">${getStandardDescriptions().length} presets</span>
            </div>
            ${getStandardDescriptions().map(d => {
            const isSel = createFormState.description === d;
            return `
                <div class="custom-desc-item group flex items-center justify-between px-2.5 py-1.5 rounded-lg cursor-pointer transition-all duration-150 ${isSel ? 'bg-emerald-50 dark:bg-[#10b981]/25 text-[#18392B] dark:text-emerald-300 font-bold border border-emerald-500/30 shadow-xs' : 'text-gray-700 dark:text-gray-200 hover:bg-emerald-50 dark:hover:bg-[#10b981]/15 hover:text-[#10b981] dark:hover:text-emerald-300'}"
                     data-desc-val="${d}">
                  <span class="text-xs truncate flex-1 mr-2" title="${d}">${d}</span>
                  <div class="flex items-center gap-1.5 shrink-0">
                    ${isSel ? `
                      <svg class="w-3.5 h-3.5 text-[#10b981] dark:text-emerald-400 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                        <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                      </svg>
                    ` : ''}
                    <button type="button" class="btn-delete-desc opacity-40 group-hover:opacity-100 hover:bg-rose-100 dark:hover:bg-rose-950/80 text-gray-400 hover:text-rose-600 dark:hover:text-rose-400 p-1 rounded-md transition-all shrink-0"
                            title="Delete this description preset" data-delete-desc="${d}">
                      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        <line x1="10" y1="11" x2="10" y2="17"></line>
                        <line x1="14" y1="11" x2="14" y2="17"></line>
                      </svg>
                    </button>
                  </div>
                </div>
              `;
          }).join('')}
            ` : ''}
            ${getCustomDescriptions().length > 0 ? `
              <div class="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-cyan-800 dark:text-cyan-400 bg-cyan-50/50 dark:bg-[#081a14]/60 rounded mt-2 flex items-center justify-between">
                <span>Custom Added Descriptions</span>
                <span class="text-[9px] font-medium text-gray-500 dark:text-gray-400">${getCustomDescriptions().length} presets</span>
              </div>
              ${getCustomDescriptions().map(d => {
            const isSel = createFormState.description === d;
            return `
                  <div class="custom-desc-item group flex items-center justify-between px-2.5 py-1.5 rounded-lg cursor-pointer transition-all duration-150 ${isSel ? 'bg-emerald-50 dark:bg-[#10b981]/25 text-[#18392B] dark:text-emerald-300 font-bold border border-emerald-500/30' : 'text-gray-700 dark:text-gray-200 hover:bg-emerald-50 dark:hover:bg-[#10b981]/15 hover:text-[#10b981] dark:hover:text-emerald-300'}"
                       data-desc-val="${d}">
                    <span class="text-xs truncate flex-1 mr-2" title="${d}">${d}</span>
                    <div class="flex items-center gap-1.5 shrink-0">
                      ${isSel ? `
                        <svg class="w-3.5 h-3.5 text-[#10b981] dark:text-emerald-400 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                          <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                        </svg>
                      ` : ''}
                      <button type="button" class="btn-delete-desc opacity-40 group-hover:opacity-100 hover:bg-rose-100 dark:hover:bg-rose-950/80 text-gray-400 hover:text-rose-600 dark:hover:text-rose-400 p-1 rounded-md transition-all shrink-0"
                              title="Delete this description preset" data-delete-desc="${d}">
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <polyline points="3 6 5 6 21 6"></polyline>
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                          <line x1="10" y1="11" x2="10" y2="17"></line>
                          <line x1="14" y1="11" x2="14" y2="17"></line>
                        </svg>
                      </button>
                    </div>
                  </div>
                `;
          }).join('')}
            ` : ''}
            <div class="custom-desc-new-item flex items-center gap-2 px-2.5 py-2 mt-1 rounded-lg cursor-pointer bg-emerald-50 dark:bg-[#08281b] text-emerald-700 dark:text-[#10b981] hover:bg-emerald-100 dark:hover:bg-[#0c3826] font-bold text-xs transition-colors">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
              <span>Add New Custom Description...</span>
            </div>
          </div>
        </div>

        <div id="modalNewDescPanel" class="hidden p-3 bg-emerald-50/70 dark:bg-[#081a14] border border-emerald-500/40 dark:border-[#10b981]/40 rounded-xl space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-xs font-bold text-[#18392B] dark:text-cyan-300 flex items-center gap-1.5">
              <span class="w-2 h-2 rounded-full bg-[#10b981]"></span>
              Add New Maintenance Description Preset
            </span>
            <button type="button" id="modalBtnCloseNewDescPanel" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xs font-bold p-1 bg-transparent border-0 cursor-pointer">
              ✕
            </button>
          </div>
          <div class="flex flex-col sm:flex-row gap-2">
            <input type="text" id="modalNewDescInput" placeholder="Enter new description template (e.g. Capacitor Replacement & Coil Wash)..."
              class="flex-1 bg-white dark:bg-slate-950 border border-gray-300 dark:border-white/20 text-gray-800 dark:text-gray-100 rounded-lg px-3 py-2 text-xs font-medium focus:outline-none focus:border-[#10b981] placeholder-gray-400">
            <button type="button" id="modalBtnSaveNewDesc"
              class="px-4 py-2 bg-[#10b981] hover:bg-emerald-400 text-slate-950 font-bold text-xs rounded-lg transition-all border-0 cursor-pointer whitespace-nowrap shadow-sm">
              Save & Apply
            </button>
          </div>
        </div>

        <div>
          <label class="block text-[11px] font-bold text-gray-600 dark:text-gray-400 mb-1 uppercase tracking-wider">Detailed Notes & Observations <span class="text-rose-500">*</span></label>
          <textarea id="modalCreateDesc" rows="2" placeholder="Select a preset above or type specific maintenance instructions and notes (minimum 5 characters)..."
            class="w-full bg-gray-50 dark:bg-slate-950 border border-gray-300 dark:border-white/15 text-gray-800 dark:text-gray-100 rounded-lg p-2.5 text-xs font-medium focus:outline-none focus:border-[#10b981] placeholder-gray-400 leading-relaxed">${createFormState.description}</textarea>
          <p id="modalDescErrorHint" class="hidden text-[10px] text-rose-500 font-semibold mt-1">Please select a preset template above or enter at least 5 characters of notes.</p>
        </div>
      </div>

      <!-- SECTION 5: CHECKLIST BUILDER -->
      <div class="bg-white dark:bg-slate-900/70 border border-gray-200 dark:border-[#10b981]/30 rounded-2xl p-4 shadow-sm">
        <div class="flex items-center justify-between mb-2.5 flex-wrap gap-2">
          <h4 class="text-xs font-bold text-[#18392B] dark:text-cyan-300 uppercase tracking-wider flex items-center gap-1.5">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" class="text-[#10b981]">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
              <polyline points="22 4 12 14.01 9 11.01"></polyline>
            </svg>
            Maintenance Checklist <span class="text-rose-500">*</span>
          </h4>
          <div class="flex items-center gap-2">
            <button type="button" id="modalBtnSelectAllChecklist"
              class="px-2.5 py-1 text-[11px] font-bold rounded-lg bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950/60 dark:hover:bg-[#10b981]/30 text-emerald-800 dark:text-emerald-300 border border-emerald-400/60 dark:border-emerald-500/40 transition-all cursor-pointer shadow-sm flex items-center gap-1 hover:scale-105 active:scale-95">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
              <span>Select All</span>
            </button>
            <button type="button" id="modalBtnUnselectAllChecklist"
              class="px-2.5 py-1 text-[11px] font-bold rounded-lg bg-gray-100 hover:bg-gray-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-white/10 transition-all cursor-pointer shadow-sm flex items-center gap-1 hover:scale-105 active:scale-95">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
              <span>Unselect All</span>
            </button>
            <span id="modalChecklistCounter" class="text-[11px] bg-gray-100 dark:bg-slate-950 px-2.5 py-1 rounded-lg border border-gray-300 dark:border-white/10 text-emerald-600 dark:text-emerald-400 font-bold">
              ${createFormState.checklist.filter(c => c.selected).length} Selected
            </span>
          </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
          ${createFormState.checklist.map((item, idx) => `
            <div class="group flex items-center justify-between p-2 rounded-lg border transition-all ${item.selected ? 'bg-emerald-50/70 dark:bg-[#081a14] border-emerald-400/50 dark:border-[#10b981]/40 text-emerald-900 dark:text-emerald-200 shadow-xs' : 'bg-gray-50 dark:bg-slate-950/60 border-gray-200 dark:border-white/10 text-gray-500 dark:text-gray-400'}">
              <label class="flex items-center gap-2 cursor-pointer flex-1 text-xs font-semibold mr-2 truncate">
                <input type="checkbox" class="modal-checklist-toggle w-3.5 h-3.5 rounded accent-[#10b981] shrink-0"
                  data-idx="${idx}" ${item.selected ? 'checked' : ''}>
                <span class="truncate" title="${item.name}">${item.name}</span>
              </label>
              <div class="flex items-center gap-2 shrink-0">
                <span class="text-[10px] font-mono text-gray-400">Not Started</span>
                <button type="button" class="btn-delete-checklist-item opacity-40 group-hover:opacity-100 hover:bg-rose-100 dark:hover:bg-rose-950/80 text-gray-400 hover:text-rose-600 dark:hover:text-rose-400 p-1 rounded-md transition-all shrink-0 cursor-pointer"
                        data-idx="${idx}" data-name="${item.name}" title="Delete checklist item">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    <line x1="10" y1="11" x2="10" y2="17"></line>
                    <line x1="14" y1="11" x2="14" y2="17"></line>
                  </svg>
                </button>
              </div>
            </div>
          `).join('')}
        </div>

        <div class="flex gap-2">
          <input type="text" id="modalCustomChecklistInput" placeholder="Add custom item (e.g. Capacitor Check)..."
            class="flex-1 bg-gray-50 dark:bg-slate-950 border border-gray-300 dark:border-white/15 text-gray-800 dark:text-gray-100 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-[#10b981] placeholder-gray-400">
          <button id="modalBtnAddCustomChecklist"
            class="px-3.5 py-1.5 bg-emerald-50 dark:bg-slate-800 hover:bg-[#10b981] text-[#18392B] dark:text-cyan-300 hover:text-white dark:hover:text-slate-950 font-bold text-xs rounded-lg border border-[#10b981]/40 transition-all cursor-pointer">
            + Add Item
          </button>
        </div>
      </div>

      <!-- FOOTER -->
      <div class="flex items-center justify-end gap-2.5 pt-3 border-t border-gray-200 dark:border-white/10">
        <button id="modalBtnCancelCreate"
          class="px-4 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 dark:bg-white/10 dark:hover:bg-white/20 text-gray-700 dark:text-gray-200 text-xs font-bold transition-all border border-gray-200 dark:border-white/10 cursor-pointer shadow-sm">
          Cancel
        </button>
        <button id="modalBtnSaveDraft"
          class="px-4 py-2 rounded-xl bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-500/20 dark:hover:bg-emerald-500/30 text-emerald-800 dark:text-emerald-300 text-xs font-bold transition-all border border-emerald-500/30 cursor-pointer shadow-sm">
          Save Draft
        </button>
        <button id="modalBtnSubmitReport"
          class="px-5 py-2 rounded-xl bg-[#10b981] hover:bg-emerald-400 text-slate-950 text-xs font-extrabold transition-all border-0 shadow-lg shadow-emerald-500/20 cursor-pointer flex items-center gap-1.5">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          Create Report
        </button>
      </div>
    `;

    // ─────────────────────────────────────────────────────────────
    // CUSTOM DROPDOWN ENGINE & EVENT BINDINGS
    // ─────────────────────────────────────────────────────────────
    const dropdownPrefixes = ['modalStaff', 'modalAircon', 'modalType', 'modalPriority', 'modalDescPreset'];

    function closeAllDropdowns() {
      dropdownPrefixes.forEach(prefix => {
        const menu = document.getElementById(`${prefix}DropdownMenu`);
        if (menu) menu.classList.add('hidden');
        const arrow = document.getElementById(`${prefix}DropdownArrow`);
        if (arrow) arrow.style.transform = 'rotate(0deg)';
        const trigger = document.getElementById(`${prefix}DropdownTrigger`);
        if (trigger) trigger.setAttribute('aria-expanded', 'false');
      });
    }

    dropdownPrefixes.forEach(prefix => {
      const trigger = document.getElementById(`${prefix}DropdownTrigger`);
      const menu = document.getElementById(`${prefix}DropdownMenu`);
      const arrow = document.getElementById(`${prefix}DropdownArrow`);
      if (!trigger || !menu) return;

      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = menu.classList.contains('hidden');
        closeAllDropdowns();
        if (willOpen) {
          menu.classList.remove('hidden');
          if (arrow) arrow.style.transform = 'rotate(180deg)';
          trigger.setAttribute('aria-expanded', 'true');
          if (prefix === 'modalType') {
            setTimeout(() => {
              const inp = document.getElementById('modalNewTypeInput');
              if (inp) {
                inp.value = '';
                inp.focus();
              }
            }, 60);
          }
        }
      });
    });

    // 1. Aircon Selection Event
    document.querySelectorAll('.custom-aircon-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const aId = item.getAttribute('data-aircon-id');
        if (aId) {
          createFormState.airconId = aId;
          const aircons = getAirconsDatabase();
          const matchedAc = aircons.find(a => a.id === aId);
          createFormState.airconType = matchedAc ? (matchedAc.brand || 'Split Type (Inverter)') : 'Split Type (Inverter)';
          const sel = document.getElementById('modalCreateAirconSelect');
          if (sel) sel.value = aId;
          renderCreateModalContent();
        }
        closeAllDropdowns();
      });
    });

    // 2. Staff Selection Event (Technician)
    document.querySelectorAll('.custom-staff-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const sName = item.getAttribute('data-staff-name');
        if (sName) {
          createFormState.staffName = sName;
          createFormState.staffId = item.getAttribute('data-staff-id') || '';
          const sel = document.getElementById('modalCreateStaffSelect');
          if (sel) sel.value = createFormState.staffId;

          // When technician changes, check if the currently selected AC is in the new technician's assigned area
          const newStaff = staffList.find(s => s.id === createFormState.staffId);
          const newStaffAircons = getAirconsForStaff(newStaff, allAircons);
          if (!newStaffAircons.some(a => a.id === createFormState.airconId)) {
            createFormState.airconId = newStaffAircons.length > 0 ? newStaffAircons[0].id : 'None';
          }

          renderCreateModalContent();
        }
        closeAllDropdowns();
      });
    });

    // 3. Maintenance Type Events (Select, Delete & Quick-Type Add)
    document.querySelectorAll('.custom-type-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.btn-delete-type')) return;
        e.stopPropagation();
        const tVal = item.getAttribute('data-type-val');
        if (tVal) {
          createFormState.type = tVal;
          const sel = document.getElementById('modalCreateType');
          if (sel) sel.value = tVal;
          const trigText = document.getElementById('modalTypeDropdownTrigger')?.querySelector('span');
          if (trigText) trigText.textContent = tVal;
          document.querySelectorAll('.custom-type-item').forEach(i => {
            const isMatch = i.getAttribute('data-type-val') === tVal;
            i.className = `custom-type-item group flex items-center justify-between px-2.5 py-1.5 rounded-lg cursor-pointer transition-all duration-150 ${isMatch ? 'bg-emerald-50 dark:bg-[#10b981]/25 text-[#18392B] dark:text-emerald-300 font-bold border border-emerald-500/30' : 'text-gray-700 dark:text-gray-200 hover:bg-emerald-50 dark:hover:bg-[#10b981]/15 hover:text-[#10b981] dark:hover:text-emerald-300'}`;
          });
        }
        closeAllDropdowns();
      });
    });

    // Delete Maintenance Type Event
    document.querySelectorAll('.btn-delete-type').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const typeToDelete = btn.getAttribute('data-delete-type');
        if (!typeToDelete) return;

        if (getAllMaintenanceTypes().length <= 1) {
          showToast('Cannot Delete', 'At least one maintenance type must remain available.', 'warning');
          return;
        }

        deleteMaintenanceType(typeToDelete);

        if (createFormState.type.toLowerCase() === typeToDelete.toLowerCase()) {
          const remaining = getAllMaintenanceTypes();
          createFormState.type = remaining[0] || 'Control Maintenance';
          const trigText = document.getElementById('modalTypeDropdownTrigger')?.querySelector('span');
          if (trigText) trigText.textContent = createFormState.type;
        }

        showToast('Type Deleted', `Removed "${typeToDelete}" from maintenance types.`, 'warning');
        renderCreateModalContent();
        // Re-open dropdown so user sees updated list
        setTimeout(() => {
          const menu = document.getElementById('modalTypeDropdownMenu');
          const arrow = document.getElementById('modalTypeDropdownArrow');
          const trigger = document.getElementById('modalTypeDropdownTrigger');
          if (menu && arrow && trigger) {
            menu.classList.remove('hidden');
            arrow.style.transform = 'rotate(180deg)';
            trigger.setAttribute('aria-expanded', 'true');
          }
        }, 60);
      });
    });

    // Save & Select New Typed Type
    const saveAndApplyNewType = () => {
      const inp = document.getElementById('modalNewTypeInput');
      const val = inp ? inp.value.trim() : '';
      if (!val) {
        showToast('Input Required', 'Please enter a maintenance type name.', 'warning');
        inp?.focus();
        return;
      }
      saveCustomType(val);
      createFormState.type = val;
      const sel = document.getElementById('modalCreateType');
      if (sel) sel.value = val;
      const trigText = document.getElementById('modalTypeDropdownTrigger')?.querySelector('span');
      if (trigText) trigText.textContent = val;
      showToast('Type Added', `Added and selected "${val}".`, 'success');
      renderCreateModalContent();
      closeAllDropdowns();
    };

    document.getElementById('modalBtnAddNewType')?.addEventListener('click', (e) => {
      e.stopPropagation();
      saveAndApplyNewType();
    });

    document.getElementById('modalNewTypeInput')?.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        saveAndApplyNewType();
      }
    });

    // Prevent typing from closing the dropdown
    document.getElementById('modalNewTypeInput')?.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    // Live search/filter as admin types in the input box
    document.getElementById('modalNewTypeInput')?.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase().trim();
      document.querySelectorAll('#modalTypeListContainer .custom-type-item').forEach(item => {
        const val = (item.getAttribute('data-type-val') || '').toLowerCase();
        item.style.display = (!q || val.includes(q)) ? 'flex' : 'none';
      });
    });

    // Top "+ Type New" shortcut button
    document.getElementById('btnToggleAddTypeDirect')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = document.getElementById('modalTypeDropdownMenu');
      const arrow = document.getElementById('modalTypeDropdownArrow');
      const trigger = document.getElementById('modalTypeDropdownTrigger');
      if (menu && arrow && trigger) {
        closeAllDropdowns();
        menu.classList.remove('hidden');
        arrow.style.transform = 'rotate(180deg)';
        trigger.setAttribute('aria-expanded', 'true');
        setTimeout(() => {
          const inp = document.getElementById('modalNewTypeInput');
          if (inp) {
            inp.value = '';
            inp.focus();
          }
        }, 60);
      }
    });

    // 4. Priority Event
    document.querySelectorAll('.custom-priority-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const pVal = item.getAttribute('data-priority-val');
        if (pVal) {
          createFormState.priority = pVal;
          const sel = document.getElementById('modalCreatePriority');
          if (sel) sel.value = pVal;
          const trigDiv = document.getElementById('modalPriorityDropdownTrigger')?.firstElementChild;
          if (trigDiv) {
            const dotColor = pVal === 'Critical' ? 'bg-rose-500 shadow-[0_0_6px_rgba(244,63,94,0.6)]' : (pVal === 'High' ? 'bg-amber-500' : (pVal === 'Medium' ? 'bg-sky-500' : 'bg-emerald-500'));
            trigDiv.innerHTML = `<span class="w-2 h-2 rounded-full ${dotColor} shrink-0"></span><span>${pVal}</span>`;
          }
          document.querySelectorAll('.custom-priority-item').forEach(i => {
            const isMatch = i.getAttribute('data-priority-val') === pVal;
            i.className = `custom-priority-item flex items-center justify-between px-2.5 py-1.5 rounded-lg cursor-pointer transition-all duration-150 ${isMatch ? 'bg-emerald-50 dark:bg-[#10b981]/25 text-[#18392B] dark:text-emerald-300 font-bold border border-emerald-500/30' : 'text-gray-700 dark:text-gray-200 hover:bg-emerald-50 dark:hover:bg-[#10b981]/15 hover:text-[#10b981] dark:hover:text-emerald-300'}`;
          });
        }
        closeAllDropdowns();
      });
    });

    // 5. Description Presets Event (Select & Delete)
    document.querySelectorAll('.custom-desc-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.btn-delete-desc')) return;
        e.stopPropagation();
        const dVal = item.getAttribute('data-desc-val');
        if (dVal) {
          createFormState.description = dVal;
          const descArea = document.getElementById('modalCreateDesc');
          if (descArea) descArea.value = dVal;
          const trigSpan = document.getElementById('modalDescPresetDropdownTrigger')?.querySelector('span');
          if (trigSpan) trigSpan.textContent = dVal;
          const sel = document.getElementById('modalDescPresetSelect');
          if (sel) sel.value = dVal;
          document.getElementById('modalNewDescPanel')?.classList.add('hidden');
        }
        closeAllDropdowns();
      });
    });

    // Delete Description Preset Event
    document.querySelectorAll('.btn-delete-desc').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const descToDelete = btn.getAttribute('data-delete-desc');
        if (!descToDelete) return;

        if (getAllDescriptionPresets().length <= 1) {
          showToast('Cannot Delete', 'At least one description preset must remain available.', 'warning');
          return;
        }

        deleteDescriptionPreset(descToDelete);

        if (createFormState.description === descToDelete) {
          createFormState.description = '';
          const descArea = document.getElementById('modalCreateDesc');
          if (descArea) descArea.value = '';
          const trigSpan = document.getElementById('modalDescPresetDropdownTrigger')?.querySelector('span');
          if (trigSpan) trigSpan.textContent = '- Select Description Template / Preset -';
        }

        showToast('Preset Deleted', 'Removed description preset.', 'warning');

        // Re-render modal content to refresh dropdown list
        renderCreateModalContent();

        // Re-open dropdown menu so user can continue seamlessly
        setTimeout(() => {
          const menu = document.getElementById('modalDescPresetDropdownMenu');
          const arrow = document.getElementById('modalDescPresetDropdownArrow');
          const trig = document.getElementById('modalDescPresetDropdownTrigger');
          if (menu) {
            menu.classList.remove('hidden');
            if (arrow) arrow.style.transform = 'rotate(180deg)';
            if (trig) trig.setAttribute('aria-expanded', 'true');
          }
        }, 60);
      });
    });

    document.querySelector('.custom-desc-new-item')?.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllDropdowns();
      const panel = document.getElementById('modalNewDescPanel');
      if (panel) {
        panel.classList.remove('hidden');
        document.getElementById('modalNewDescInput')?.focus();
      }
    });

    // Global click and Escape listeners for dropdown closing
    if (!window._ecoMaintenanceDropdownGlobalBound) {
      window._ecoMaintenanceDropdownGlobalBound = true;
      document.addEventListener('click', (e) => {
        if (!e.target.closest('[id$="DropdownTrigger"]') && !e.target.closest('[id$="DropdownMenu"]')) {
          dropdownPrefixes.forEach(prefix => {
            document.getElementById(`${prefix}DropdownMenu`)?.classList.add('hidden');
            const arrow = document.getElementById(`${prefix}DropdownArrow`);
            if (arrow) arrow.style.transform = 'rotate(0deg)';
            document.getElementById(`${prefix}DropdownTrigger`)?.setAttribute('aria-expanded', 'false');
          });
        }
      });

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          dropdownPrefixes.forEach(prefix => {
            document.getElementById(`${prefix}DropdownMenu`)?.classList.add('hidden');
            const arrow = document.getElementById(`${prefix}DropdownArrow`);
            if (arrow) arrow.style.transform = 'rotate(0deg)';
            document.getElementById(`${prefix}DropdownTrigger`)?.setAttribute('aria-expanded', 'false');
          });
        }
      });
    }

    // Standard Form & Date Event Bindings
    document.getElementById('modalCreateDueDate')?.addEventListener('change', (e) => { createFormState.dueDate = e.target.value; });

    // Toggle Add New Description Panel
    document.getElementById('modalBtnToggleNewDesc')?.addEventListener('click', () => {
      const panel = document.getElementById('modalNewDescPanel');
      if (panel) {
        panel.classList.toggle('hidden');
      }
    });

    document.getElementById('modalBtnCloseNewDescPanel')?.addEventListener('click', () => {
      document.getElementById('modalNewDescPanel')?.classList.add('hidden');
    });

    // Save New Description Preset
    document.getElementById('modalBtnSaveNewDesc')?.addEventListener('click', () => {
      const inp = document.getElementById('modalNewDescInput');
      const val = inp ? inp.value.trim() : '';
      if (val) {
        saveCustomDescription(val);
        createFormState.description = val;
        showToast('Preset Added', `Saved "${val}" as a maintenance description preset.`, 'success');
        renderCreateModalContent();
      }
    });

    document.getElementById('modalCreateDesc')?.addEventListener('input', (e) => { createFormState.description = e.target.value; });

    // Select All Checklist Items
    document.getElementById('modalBtnSelectAllChecklist')?.addEventListener('click', (e) => {
      e.preventDefault();
      createFormState.checklist.forEach(item => { item.selected = true; });
      document.querySelectorAll('.modal-checklist-toggle').forEach(chk => {
        chk.checked = true;
        const parentBox = chk.closest('div');
        if (parentBox) {
          parentBox.className = 'flex items-center justify-between p-2 rounded-lg border bg-emerald-50/70 dark:bg-[#081a14] border-emerald-400/50 dark:border-[#10b981]/40 text-emerald-900 dark:text-emerald-200';
        }
      });
      const counter = document.getElementById('modalChecklistCounter');
      if (counter) {
        counter.textContent = `${createFormState.checklist.length} Selected`;
      }
    });

    // Unselect All Checklist Items
    document.getElementById('modalBtnUnselectAllChecklist')?.addEventListener('click', (e) => {
      e.preventDefault();
      createFormState.checklist.forEach(item => { item.selected = false; });
      document.querySelectorAll('.modal-checklist-toggle').forEach(chk => {
        chk.checked = false;
        const parentBox = chk.closest('div');
        if (parentBox) {
          parentBox.className = 'flex items-center justify-between p-2 rounded-lg border bg-gray-50 dark:bg-slate-950/60 border-gray-200 dark:border-white/10 text-gray-500 dark:text-gray-400';
        }
      });
      const counter = document.getElementById('modalChecklistCounter');
      if (counter) {
        counter.textContent = `0 Selected`;
      }
    });

    document.querySelectorAll('.modal-checklist-toggle').forEach(t => {
      t.addEventListener('change', (e) => {
        const idx = parseInt(t.getAttribute('data-idx'));
        if (createFormState.checklist[idx]) {
          createFormState.checklist[idx].selected = t.checked;
          const parentBox = t.closest('.group') || t.closest('div');
          if (parentBox) {
            if (t.checked) {
              parentBox.className = 'group flex items-center justify-between p-2 rounded-lg border transition-all bg-emerald-50/70 dark:bg-[#081a14] border-emerald-400/50 dark:border-[#10b981]/40 text-emerald-900 dark:text-emerald-200 shadow-xs';
            } else {
              parentBox.className = 'group flex items-center justify-between p-2 rounded-lg border transition-all bg-gray-50 dark:bg-slate-950/60 border-gray-200 dark:border-white/10 text-gray-500 dark:text-gray-400';
            }
          }
        }
        const counter = document.getElementById('modalChecklistCounter');
        if (counter) {
          const count = createFormState.checklist.filter(c => c.selected).length;
          counter.textContent = `${count} Selected`;
        }
      });
    });

    // Delete Checklist Item
    document.querySelectorAll('.btn-delete-checklist-item').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const idx = parseInt(btn.getAttribute('data-idx'), 10);
        const name = btn.getAttribute('data-name') || 'Item';
        if (isNaN(idx) || idx < 0 || idx >= createFormState.checklist.length) return;

        if (createFormState.checklist.length <= 1) {
          showToast('Checklist Required', 'At least one checklist item must remain.', 'warning');
          return;
        }

        createFormState.checklist.splice(idx, 1);
        saveActiveChecklistTemplates(createFormState.checklist);
        showToast('Item Deleted', `Removed "${name}" from checklist.`, 'warning');
        renderCreateModalContent();
      });
    });

    // Add Custom Checklist Item
    document.getElementById('modalBtnAddCustomChecklist')?.addEventListener('click', () => {
      const inp = document.getElementById('modalCustomChecklistInput');
      if (inp && inp.value.trim()) {
        const val = inp.value.trim();
        if (createFormState.checklist.some(c => c.name.toLowerCase() === val.toLowerCase())) {
          showToast('Duplicate Item', `"${val}" is already in the checklist.`, 'warning');
          return;
        }
        createFormState.checklist.push({ name: val, selected: true });
        saveActiveChecklistTemplates(createFormState.checklist);
        inp.value = '';
        renderCreateModalContent();
      }
    });

    document.getElementById('modalCustomChecklistInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('modalBtnAddCustomChecklist')?.click();
      }
    });

    let _formErrorTimer = null;
    let _formErrorInterval = null;

    function hideFormErrorSmoothly() {
      if (_formErrorTimer) { clearTimeout(_formErrorTimer); _formErrorTimer = null; }
      if (_formErrorInterval) { clearInterval(_formErrorInterval); _formErrorInterval = null; }
      const banner = document.getElementById('modalFormErrorBanner');
      if (!banner || banner.classList.contains('hidden')) return;
      banner.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
      banner.style.opacity = '0';
      banner.style.transform = 'translateY(-4px)';
      setTimeout(() => {
        banner.classList.add('hidden');
        banner.style.opacity = '';
        banner.classList.remove('error-banner-exit');
      }, 300);
      if (_formErrorTimer) clearTimeout(_formErrorTimer);
      if (_formErrorInterval) clearInterval(_formErrorInterval);
    }

    function showFormError(title, msg, targetElement = null, durationSeconds = 5) {
      const banner = document.getElementById('modalFormErrorBanner');
      const titleEl = document.getElementById('modalFormErrorTitle');
      const textEl = document.getElementById('modalFormErrorText');
      const timerBadge = document.getElementById('modalFormErrorTimerBadge');
      const progressBar = document.getElementById('modalFormErrorProgressBar');

      if (banner && titleEl && textEl) {
        titleEl.textContent = title;
        textEl.textContent = msg;
        if (timerBadge) timerBadge.textContent = `${durationSeconds}s`;

        banner.classList.remove('hidden', 'error-banner-exit');
        banner.classList.remove('form-error-shake');
        void banner.offsetWidth; // Force re-flow for animation
        banner.classList.add('form-error-shake');

        if (progressBar) {
          progressBar.style.transition = 'none';
          progressBar.style.width = '100%';
          void progressBar.offsetWidth;
          progressBar.style.transition = `width ${durationSeconds}s linear`;
          progressBar.style.width = '0%';
        }

        if (_formErrorTimer) clearTimeout(_formErrorTimer);
        if (_formErrorInterval) clearInterval(_formErrorInterval);

        let remainingSecs = durationSeconds;
        _formErrorInterval = setInterval(() => {
          remainingSecs--;
          if (timerBadge && remainingSecs >= 0) {
            timerBadge.textContent = `${remainingSecs}s`;
          }
          if (remainingSecs <= 0) {
            clearInterval(_formErrorInterval);
          }
        }, 1000);

        _formErrorTimer = setTimeout(() => {
          hideFormErrorSmoothly();
        }, durationSeconds * 1000);
      }

      if (targetElement) {
        targetElement.classList.add('border-rose-500', 'ring-2', 'ring-rose-500/20');
        targetElement.focus?.();
      }
      showToast(title, msg, 'error');
    }

    function validateCreateReportForm() {
      // 1. Aircon Unit Validation
      if (!createFormState.airconId || createFormState.airconId === 'None') {
        showFormError('Aircon Unit Required', 'Please select a valid target Aircon unit.', document.getElementById('modalAirconDropdownTrigger'));
        return false;
      }

      const selectedAc = AIRCONS_DATABASE.find(a => a.id === createFormState.airconId);
      if (!selectedAc) {
        showFormError('AC Unit Unavailable', 'The original AC unit could not be loaded. Select an available unit explicitly before saving.');
        return false;
      }
      const activeReport = findActiveUnverifiedReportForAircon(createFormState.airconId, selectedAc?.nodeId, editingReportId);
      if (activeReport) {
        showFormError(
          'Duplicate Report Rejected',
          `${selectedAc.model || selectedAc.id} already has report ${activeReport.id} (${activeReport.status}). Complete and verify it before creating another.`,
          document.getElementById('modalAirconDropdownTrigger'),
          6
        );
        return false;
      }

      // 2. Technician Assignment Validation
      if (!createFormState.staffName || createFormState.staffName === 'No technicians registered') {
        showFormError('Technician Assignment Required', 'Please assign an active technician to this report.', document.getElementById('modalStaffDropdownTrigger'));
        return false;
      }

      const assignedStaff = staffList.find(s => s.id === createFormState.staffId);
      const staffAllowedAircons = getAirconsForStaff(assignedStaff, AIRCONS_DATABASE);
      const originalReport = editingReportId ? getReports().find(r => r.id === editingReportId) : null;
      const preservesAssignment = originalReport && originalReport.airconId === createFormState.airconId && originalReport.staffName === createFormState.staffName;
      if (!preservesAssignment && !staffAllowedAircons.some(a => a.id === createFormState.airconId)) {
        const staffLoc = resolveStaffLocation(assignedStaff) || 'assigned area';
        showFormError(
          'Unassigned Aircon Unit',
          `The technician "${createFormState.staffName}" is assigned to "${staffLoc}", which does not cover "${createFormState.airconId}". Please select an AC unit within their assigned location.`,
          document.getElementById('modalAirconDropdownTrigger'),
          6
        );
        return false;
      }

      // 3. Due Date Validation
      if (!createFormState.dueDate) {
        showFormError('Due Date Required', 'Please select a scheduled due date.', document.getElementById('modalCreateDueDate'));
        return false;
      }
      const dueDateVal = createFormState.dueDate;
      const todayStr = new Date().toISOString().split('T')[0];
      if (dueDateVal < todayStr) {
        showFormError('Invalid Due Date', 'Scheduled due date cannot be in the past.', document.getElementById('modalCreateDueDate'));
        return false;
      }

      // 4. Description Validation
      const descVal = (createFormState.description || '').trim();
      if (!descVal || descVal.length < 5) {
        showFormError('Description Required', 'Please select a preset template or type detailed notes (minimum 5 characters).', document.getElementById('modalCreateDesc'));
        return false;
      }

      // 5. Checklist Task Selection Validation
      const selectedTasksCount = (createFormState.checklist || []).filter(c => c.selected).length;
      if (selectedTasksCount === 0) {
        showFormError('Checklist Tasks Required', 'Please select at least one maintenance task.');
        return false;
      }

      return true;
    }

    let _isSubmittingReport = false;
    document.getElementById('modalBtnSubmitReport')?.addEventListener('click', async () => {
      if (_isSubmittingReport || !validateCreateReportForm()) return;

      _isSubmittingReport = true;
      const submitBtn = document.getElementById('modalBtnSubmitReport');
      const originalBtnHTML = submitBtn ? submitBtn.innerHTML : '';
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.classList.add('opacity-70', 'cursor-not-allowed');
        submitBtn.innerHTML = `
          <svg class="animate-spin h-3.5 w-3.5 text-slate-950 inline-block mr-1" viewBox="0 0 24 24" fill="none">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <span>${editingReportId ? 'Saving Changes...' : 'Creating Report...'}</span>
        `;
      }

      try {
        const reports = getReports();
        const selectedAc = AIRCONS_DATABASE.find(a => a.id === createFormState.airconId);

        // Direct database-level pre-check
        const sb = getSb();
        if (sb) {
          try {
            const { data: dbActiveReports, error: dbErr } = await sb
              .from('maintenance_reports')
              .select('id, aircon_id, aircon_name, status')
              .in('status', ['Pending', 'Assigned', 'In Progress', 'For Verification', 'Pending Verification', 'Awaiting Admin Verification', 'Needs Repair', 'Under Repair']);

            if (!dbErr && Array.isArray(dbActiveReports) && dbActiveReports.length > 0) {
              const lowerTarget = String(createFormState.airconId || '').toLowerCase().trim();
              const lowerNode = selectedAc?.nodeId ? String(selectedAc.nodeId).toLowerCase().trim() : null;

              const dbDuplicate = dbActiveReports.find(r => {
                if (editingReportId && r.id === editingReportId) return false;
                const rAircon = String(r.aircon_name || r.aircon_id || '').toLowerCase().trim();
                const rNode = String(r.aircon_id || '').toLowerCase().trim();
                return (rAircon && (rAircon === lowerTarget || (lowerNode && rAircon === lowerNode))) ||
                  (lowerNode && rNode && rNode === lowerNode);
              });

              if (dbDuplicate) {
                showFormError('Duplicate Report Rejected', `Aircon unit "${selectedAc.model || selectedAc.id}" already has an ongoing report (${dbDuplicate.id}) in database.`, null, 6);
                throw new Error('Duplicate entry');
              }
            }
          } catch (dbCheckErr) {
            if (dbCheckErr.message === 'Duplicate entry') throw dbCheckErr;
            console.warn('[Duplicate Check Warning]:', dbCheckErr.message);
          }
        }

        // Handle Editing
        if (editingReportId) {
          const report = reports.find(r => r.id === editingReportId);
          if (report) {
            const assignedStaff = staffList.find(s => s.id === createFormState.staffId);
            report.airconId = selectedAc.id;
            report.aircon_id = selectedAc.nodeId || selectedAc.id;
            report.nodeId = selectedAc.nodeId || selectedAc.id;
            report.airconType = createFormState.airconType || selectedAc.brand || 'Split Type (Inverter)';
            report.room = selectedAc.room;
            report.room_id = selectedAc.roomId || null;
            report.roomId = selectedAc.roomId || null;
            report.type = createFormState.type;
            report.priority = createFormState.priority;
            report.staffName = createFormState.staffName;
            report.staff_id = assignedStaff ? assignedStaff.id : null;
            report.staffId = assignedStaff ? assignedStaff.id : null;
            report.dueDate = createFormState.dueDate;
            report.description = createFormState.description;

            const existingTasksMap = {};
            (report.tasks || []).forEach(t => { existingTasksMap[t.name] = t; });
            report.tasks = createFormState.checklist
              .filter(c => c.selected)
              .map((c, i) => {
                if (existingTasksMap[c.name]) return existingTasksMap[c.name];
                return { id: 'task-' + Date.now().toString(36) + '-' + i, name: c.name, status: 'Not Started', notes: '', updated: 'Today' };
              });

            if (!report.timeline) report.timeline = [];
            report.timeline.unshift({ title: 'Report Updated by Admin', time: 'Just now', done: true, by: 'Admin' });

            const updatedReportId = editingReportId;
            await saveReports(reports, report, false);
            closeCreateReportModal();
            showToast('Report Updated', `Maintenance Report ${updatedReportId} has been updated successfully!`, 'success');
            refreshPageReportsView();
            openDetailModal(updatedReportId);
            return;
          }
        }

        // Handle Creation
        const newId = generateNextReportId(reports);
        const selectedTasks = createFormState.checklist
          .filter(c => c.selected)
          .map((c, i) => ({ id: i + 1, name: c.name, status: 'Not Started', notes: '', updated: 'Today' }));

        const assignedStaff = staffList.find(s => s.id === createFormState.staffId);
        const newReport = {
          id: newId,
          airconId: selectedAc.id,
          aircon_id: selectedAc.nodeId || selectedAc.id,
          nodeId: selectedAc.nodeId || selectedAc.id,
          airconType: createFormState.airconType || selectedAc.brand || 'Split Type (Inverter)',
          room: selectedAc.room,
          room_id: selectedAc.roomId || null,
          roomId: selectedAc.roomId || null,
          type: createFormState.type,
          priority: createFormState.priority,
          staffName: createFormState.staffName,
          staff_id: assignedStaff ? assignedStaff.id : null,
          staffId: assignedStaff ? assignedStaff.id : null,
          dueDate: createFormState.dueDate,
          createdDate: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
          created: new Date().toISOString(),
          status: 'Pending',
          description: createFormState.description,
          tasks: selectedTasks,
          issue: null,
          timeline: [
            { title: 'Report Created', time: 'Just now', done: true, by: 'Admin' },
            { title: `Assigned to ${createFormState.staffName}`, time: 'Pending Dispatch', done: false }
          ]
        };

        reports.unshift(newReport);
        await saveReports(reports, newReport, true);

        closeCreateReportModal();
        showToast('Report Created', `Maintenance Report ${newId} has been saved successfully!`, 'success');

        if (typeof window.resetPageReportFilters === 'function') {
          window.resetPageReportFilters(true);
        } else {
          refreshPageReportsView();
        }

        try { openDetailModal(newId); } catch (_) { }


        return;
      } catch (err) {
        if (err.message !== 'Duplicate entry') {
          console.error('Error saving report:', err);
          showToast('Error', 'Failed to save report. Please try again.', 'error');
        }
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.classList.remove('opacity-70', 'cursor-not-allowed');
          submitBtn.innerHTML = originalBtnHTML;
        }
      } finally {
        _isSubmittingReport = false;
      }
    });
  }

  // ===================================================================
  // 3. REPORT DETAILS MODAL
  // ===================================================================

  let currentDetailId = null;

  function startActiveModalPolling(reportId) {
    stopActiveModalPolling();
    _activeModalPollTimer = setInterval(async () => {
      if (!currentDetailId) {
        stopActiveModalPolling();
        return;
      }
      // If user is actively typing in an input, do not re-render modal and interrupt typing
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT')) {
        return;
      }
      const sb = getSb();
      if (!sb) return;
      try {
        const { data, error } = await sb.from('maintenance_reports').select('*').eq('id', currentDetailId).maybeSingle();
        if (!error && data) {
          const fresh = normalizeReport(data);
          if (fresh) {
            // Apply in-memory synchronization first to compare synced states accurately
            const tempCache = _reportsCache.map(r => String(r.id) === String(currentDetailId) ? fresh : r);
            if (!tempCache.some(r => String(r.id) === String(currentDetailId))) tempCache.unshift(fresh);
            const syncedCache = syncReportsWithLinkedRepairs(tempCache);
            const syncedFresh = syncedCache.find(r => String(r.id) === String(currentDetailId));

            const cur = _reportsCache.find(r => String(r.id) === String(currentDetailId));
            const curKey = cur ? `${cur.status}_${cur.updated || ''}_${JSON.stringify(cur.tasks)}_${JSON.stringify(cur.issue)}` : '';
            const freshKey = syncedFresh ? `${syncedFresh.status}_${syncedFresh.updated || ''}_${JSON.stringify(syncedFresh.tasks)}_${JSON.stringify(syncedFresh.issue)}` : '';

            if (curKey !== freshKey) {
              console.log('[Active Modal Live Sync] Database record changed, live re-rendering modal...');
              const idx = _reportsCache.findIndex(r => String(r.id) === String(currentDetailId));
              if (idx !== -1) _reportsCache[idx] = fresh;
              else _reportsCache.unshift(fresh);
              _reportsCache = syncReportsWithLinkedRepairs(_reportsCache);
              try {
                localStorage.setItem('ecoTrack_maintenance_reports', JSON.stringify(_reportsCache));
              } catch (_) { }
              renderDetailModalContent();
              if (activeChecklistReportId) {
                try { renderCurrentChecklistItemModal(); } catch (_) { }
              }
              refreshPageReportsView();
            }
          }
        }
      } catch (_) { }
    }, 6000);
  }

  function stopActiveModalPolling() {
    if (_activeModalPollTimer) {
      clearInterval(_activeModalPollTimer);
      _activeModalPollTimer = null;
    }
  }

  function openDetailModal(reportId) {
    currentDetailId = reportId;
    let modal = document.getElementById('ecoReportDetailModal');
    if (!modal) {
      injectDetailModalHTML();
      modal = document.getElementById('ecoReportDetailModal');
    }
    if (!modal) {
      console.error('[EcoTrack] Modal container ecoReportDetailModal could not be created');
      return;
    }

    try {
      renderDetailModalContent();
    } catch (e) {
      console.error('[EcoTrack Maintenance] Detail modal render error:', e);
    }

    modal.classList.remove('hidden');
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    // Start live polling while modal remains open
    startActiveModalPolling(reportId);

    // Live background query to ensure fresh photos and tasks from Supabase immediately
    const sb = getSb();
    if (sb && reportId) {
      sb.from('maintenance_reports').select('*').eq('id', reportId).maybeSingle().then(({ data, error }) => {
        if (!error && data) {
          const fresh = normalizeReport(data);
          if (fresh) {
            const idx = _reportsCache.findIndex(r => String(r.id) === String(reportId));
            if (idx !== -1) _reportsCache[idx] = fresh;
            else _reportsCache.unshift(fresh);
            _reportsCache = syncReportsWithLinkedRepairs(_reportsCache);
            try {
              localStorage.setItem('ecoTrack_maintenance_reports', JSON.stringify(_reportsCache));
            } catch (_) { }
            if (currentDetailId === reportId) renderDetailModalContent();
          }
        }
      }).catch(err => console.warn('[openDetailModal live fetch warn]:', err));
    }
  }

  function closeDetailModal() {
    stopActiveModalPolling();
    currentDetailId = null;
    const modal = document.getElementById('ecoReportDetailModal');
    if (modal) {
      modal.classList.add('hidden');
      modal.style.display = 'none';
      document.body.style.overflow = '';
    }
    refreshPageReportsView();
  }

  // ===================================================================
  // 3.1. CHECKLIST ITEM MODAL (MATCHING MOBILE/TASK FORM SPEC)
  // ===================================================================

  const TASK_DESCRIPTIONS = {
    'Aircon Cleaning': 'Deep clean the evaporator and condenser coils, drain pan, blower wheel, and outer housing to ensure optimal airflow and hygienic operation.',
    'Filter Cleaning': 'Inspect and thoroughly clean air filter meshes, remove accumulated dust, and check for tears, blockage, or frame deformities.',
    'Temperature Control Inspection': 'Inspect thermal control probe, check calibration against ambient standards, and verify telemetry reading stability.',
    'Air Pressure Control Inspection': 'Inspect differential pressure tubes, clear dust obstructions, and test airflow pressure control response.',
    'Energy Control Inspection': 'Verify CT clamps, voltage input terminals, and power telemetry logging for real-time energy calculation.',
    'Control Calibration': 'Zero-offset calibration and multi-point test verification against ambient laboratory references.',
    'Control Wiring Inspection': 'Check physical cable integrity, crimp connections, signal shielding, and terminal screw torque.'
  };

  let activeChecklistReportId = null;
  let activeChecklistTaskId = null;
  let activeChecklistStatus = 'Not Started';
  let activeChecklistPhoto = null;

  function injectChecklistItemModalHTML() {
    if (document.getElementById('ecoChecklistItemModal')) return;

    const modalHTML = `
      <div id="ecoChecklistItemModal" class="hidden fixed inset-0 bg-slate-950/75 backdrop-blur-sm z-[9999] flex items-center justify-center p-3 sm:p-4 transition-all">
        <div class="bg-white dark:bg-[#0c1328] border-2 border-gray-200 dark:border-[#10b981]/50 rounded-3xl w-full max-w-md shadow-2xl flex flex-col overflow-hidden text-gray-800 dark:text-gray-100 transition-all max-h-[92vh]">
          <div id="ecoChecklistItemModalHeader" class="px-5 pt-5 pb-3 flex items-start justify-between border-b border-gray-100 dark:border-white/10 shrink-0">
            <!-- Header injected -->
          </div>
          <div id="ecoChecklistItemModalBody" class="p-5 overflow-y-auto eco-slim-scrollbar space-y-4 flex-1">
            <!-- Body injected -->
          </div>
          <div id="ecoChecklistItemModalFooter" class="px-5 py-3.5 bg-gray-50 dark:bg-slate-950/80 border-t border-gray-100 dark:border-white/10 flex items-center justify-between gap-2 shrink-0">
            <!-- Footer injected -->
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHTML);

    const modal = document.getElementById('ecoChecklistItemModal');
    modal?.addEventListener('click', (e) => {
      if (e.target === modal) closeChecklistItemModal();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) {
        closeChecklistItemModal();
      }
    });
  }

  function closeChecklistItemModal() {
    activeChecklistReportId = null;
    activeChecklistTaskId = null;
    const modal = document.getElementById('ecoChecklistItemModal');
    if (modal) {
      modal.classList.add('hidden');
      modal.style.display = 'none';
      document.body.style.overflow = '';
    }
    refreshPageReportsView();
  }

  // ===================================================================
  // 3A. IN-APP IMAGE LIGHTBOX MODAL (PREVENTS BLANK ELECTRON WINDOWS)
  // ===================================================================
  function injectImageLightboxModalHTML() {
    if (document.getElementById('ecoImageLightboxModal')) return;

    const modalHTML = `
      <div id="ecoImageLightboxModal" class="hidden fixed inset-0 bg-slate-950/95 backdrop-blur-md z-[500000] flex flex-col items-center justify-between p-3 sm:p-5 transition-all duration-200 opacity-0 select-none" style="z-index: 500000;">
        <!-- Top bar with title, counter badge, and close button -->
        <div class="w-full max-w-6xl flex items-center justify-between px-2 py-2 mb-1 shrink-0 relative z-20">
          <div class="flex items-center gap-2.5 text-white min-w-0 pr-3">
            <div class="w-7 h-7 rounded-lg bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shrink-0">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/><circle cx="12" cy="13" r="3"/></svg>
            </div>
            <span id="ecoLightboxTitle" class="text-sm sm:text-base font-bold text-gray-100 truncate">Proof of Maintenance</span>
            <span id="ecoLightboxBadge" class="hidden px-2.5 py-0.5 text-xs font-mono font-bold rounded-full bg-white/15 text-white border border-white/25 shrink-0">1 / 1</span>
          </div>
          <button type="button" id="btnCloseImageLightbox" class="w-9 h-9 rounded-full bg-white/10 hover:bg-white/25 text-white flex items-center justify-center font-bold text-base cursor-pointer transition-all border border-white/15 shadow-lg shrink-0" title="Close image preview (Esc)">
            ✕
          </button>
        </div>

        <!-- Center Area: Left Arrow, Image Viewport, Right Arrow -->
        <div class="relative flex-1 w-full max-w-6xl flex items-center justify-center min-h-0 overflow-hidden">
          <!-- Prev Arrow Button -->
          <button type="button" id="btnLightboxPrev" class="hidden absolute left-2 sm:left-4 top-1/2 -translate-y-1/2 w-11 h-11 sm:w-13 sm:h-13 rounded-full bg-black/60 hover:bg-black/90 text-white flex items-center justify-center border-2 border-white/30 shadow-2xl backdrop-blur-md cursor-pointer transition-all hover:scale-110 z-30 group" title="Previous photo (Left Arrow or scroll left)">
            <svg class="w-6 h-6 transition-transform group-hover:-translate-x-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M15 19l-7-7 7-7"/></svg>
          </button>

          <!-- Main Image Container -->
          <div id="ecoLightboxImageContainer" class="relative flex items-center justify-center w-full h-full p-2 cursor-default overflow-hidden">
            <img id="ecoLightboxImage" src="" alt="Proof of Maintenance" class="max-h-[76vh] max-w-full object-contain rounded-2xl shadow-2xl border-2 border-emerald-500/30 bg-slate-950 transition-transform duration-200 select-none" onclick="event.stopPropagation()">
          </div>

          <!-- Next Arrow Button -->
          <button type="button" id="btnLightboxNext" class="hidden absolute right-2 sm:right-4 top-1/2 -translate-y-1/2 w-11 h-11 sm:w-13 sm:h-13 rounded-full bg-black/60 hover:bg-black/90 text-white flex items-center justify-center border-2 border-white/30 shadow-2xl backdrop-blur-md cursor-pointer transition-all hover:scale-110 z-30 group" title="Next photo (Right Arrow or scroll right)">
            <svg class="w-6 h-6 transition-transform group-hover:translate-x-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7"/></svg>
          </button>
        </div>

        <!-- Bottom Area: Thumbnail Strip + Navigation Hints -->
        <div class="w-full max-w-4xl flex flex-col items-center gap-2 mt-2 shrink-0 z-20">
          <!-- Thumbnail Preview Strip (visible when photos.length > 1) -->
          <div id="ecoLightboxThumbnails" class="hidden flex items-center justify-center gap-2 max-w-full overflow-x-auto p-1.5 eco-slim-scrollbar rounded-xl bg-black/40 backdrop-blur-sm border border-white/10">
            <!-- Generated dynamically -->
          </div>

          <!-- Footer Instruction Caption -->
          <div class="text-center text-[11px] sm:text-xs text-gray-400 flex items-center flex-wrap justify-center gap-2">
            <span id="ecoLightboxNavHint" class="hidden items-center gap-1.5">
              Scroll wheel / drag left-right or press <kbd class="px-1.5 py-0.5 rounded bg-white/10 text-white font-mono text-[10px] border border-white/10">←</kbd> <kbd class="px-1.5 py-0.5 rounded bg-white/10 text-white font-mono text-[10px] border border-white/10">→</kbd> to navigate
              •
            </span>
            <span>Click backdrop or press <kbd class="px-1.5 py-0.5 rounded bg-white/10 text-white font-mono text-[10px] border border-white/10">Esc</kbd> to return</span>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHTML);

    const modal = document.getElementById('ecoImageLightboxModal');
    const closeBtn = document.getElementById('btnCloseImageLightbox');
    const prevBtn = document.getElementById('btnLightboxPrev');
    const nextBtn = document.getElementById('btnLightboxNext');

    closeBtn?.addEventListener('click', closeImageLightbox);
    modal?.addEventListener('click', (e) => {
      if (e.target === modal || e.target.id === 'ecoLightboxImageContainer') {
        closeImageLightbox();
      }
    });

    prevBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      lightboxPrev();
    });

    nextBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      lightboxNext();
    });

    // Keyboard navigation (Arrow keys + Esc + A/D)
    document.addEventListener('keydown', (e) => {
      if (!modal || modal.classList.contains('hidden') || modal.style.display === 'none') return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.stopImmediatePropagation();
        closeImageLightbox();
      } else if (e.key === 'ArrowLeft' || e.key === 'Left' || e.key === 'a' || e.key === 'A') {
        e.stopPropagation();
        lightboxPrev();
      } else if (e.key === 'ArrowRight' || e.key === 'Right' || e.key === 'd' || e.key === 'D') {
        e.stopPropagation();
        lightboxNext();
      }
    }, true);

    // Mouse wheel navigation (scroll wheel left/right or up/down)
    let wheelDebounceTimer = null;
    modal.addEventListener('wheel', (e) => {
      if (!window._lightboxState || !Array.isArray(window._lightboxState.photos) || window._lightboxState.photos.length <= 1) return;
      if (wheelDebounceTimer) return;
      const dx = e.deltaX;
      const dy = e.deltaY;
      if (Math.abs(dx) > 15 || Math.abs(dy) > 25) {
        if (dx > 15 || dy > 25) {
          lightboxNext();
        } else if (dx < -15 || dy < -25) {
          lightboxPrev();
        }
        wheelDebounceTimer = setTimeout(() => {
          wheelDebounceTimer = null;
        }, 220);
      }
    }, { passive: true });

    // Touch swipe navigation for touchpads / mobile
    let touchStartX = 0;
    let touchStartY = 0;
    modal.addEventListener('touchstart', (e) => {
      if (e.touches && e.touches[0]) {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
      }
    }, { passive: true });

    modal.addEventListener('touchend', (e) => {
      if (!window._lightboxState || !Array.isArray(window._lightboxState.photos) || window._lightboxState.photos.length <= 1) return;
      if (e.changedTouches && e.changedTouches[0]) {
        const dx = e.changedTouches[0].clientX - touchStartX;
        const dy = e.changedTouches[0].clientY - touchStartY;
        if (Math.abs(dx) > 35 && Math.abs(dx) > Math.abs(dy)) {
          if (dx < 0) lightboxNext();
          else lightboxPrev();
        }
      }
    }, { passive: true });

    // Mouse drag navigation on image (click & drag left/right)
    let isDragging = false;
    let dragStartX = 0;
    const imgContainer = document.getElementById('ecoLightboxImageContainer');
    if (imgContainer) {
      imgContainer.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        isDragging = true;
        dragStartX = e.clientX;
      });
      window.addEventListener('mouseup', (e) => {
        if (!isDragging) return;
        isDragging = false;
        const dx = e.clientX - dragStartX;
        if (Math.abs(dx) > 45) {
          if (dx < 0) lightboxNext();
          else lightboxPrev();
        }
      });
    }
  }

  function updateLightboxView() {
    const state = window._lightboxState;
    if (!state || !Array.isArray(state.photos) || state.photos.length === 0) return;

    const img = document.getElementById('ecoLightboxImage');
    const badge = document.getElementById('ecoLightboxBadge');
    const prevBtn = document.getElementById('btnLightboxPrev');
    const nextBtn = document.getElementById('btnLightboxNext');
    const thumbsContainer = document.getElementById('ecoLightboxThumbnails');
    const navHint = document.getElementById('ecoLightboxNavHint');
    if (!img) return;

    const currentIdx = Math.max(0, Math.min(state.current, state.photos.length - 1));
    state.current = currentIdx;
    const photoUrl = state.photos[currentIdx];

    // Smooth image transition
    img.style.opacity = '0.4';
    img.style.transform = 'scale(0.98)';
    const temp = new Image();
    temp.onload = () => {
      img.src = photoUrl;
      img.style.opacity = '1';
      img.style.transform = 'scale(1)';
    };
    temp.onerror = () => {
      img.src = photoUrl;
      img.style.opacity = '1';
      img.style.transform = 'scale(1)';
    };
    temp.src = photoUrl;

    const hasMultiple = state.photos.length > 1;

    // Slide Counter Badge
    if (badge) {
      if (hasMultiple) {
        badge.textContent = `${currentIdx + 1} / ${state.photos.length}`;
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    }

    // Navigation buttons
    if (prevBtn) {
      if (hasMultiple) prevBtn.classList.remove('hidden');
      else prevBtn.classList.add('hidden');
    }
    if (nextBtn) {
      if (hasMultiple) nextBtn.classList.remove('hidden');
      else nextBtn.classList.add('hidden');
    }

    // Navigation hint
    if (navHint) {
      if (hasMultiple) navHint.classList.remove('hidden');
      else navHint.classList.add('hidden');
    }

    // Thumbnails strip
    if (thumbsContainer) {
      if (hasMultiple) {
        thumbsContainer.classList.remove('hidden');
        thumbsContainer.innerHTML = state.photos.map((p, i) => `
          <button type="button" class="lightbox-thumb-btn shrink-0 w-11 h-11 sm:w-13 sm:h-13 rounded-lg overflow-hidden border-2 transition-all cursor-pointer ${i === currentIdx ? 'border-emerald-400 scale-105 shadow-md shadow-emerald-500/40 opacity-100' : 'border-white/20 opacity-50 hover:opacity-90'}" onclick="window._lightboxGoTo && window._lightboxGoTo(${i})" title="Jump to photo ${i + 1}">
            <img src="${p}" alt="Thumb ${i + 1}" class="w-full h-full object-cover">
          </button>
        `).join('');

        const activeThumb = thumbsContainer.children[currentIdx];
        if (activeThumb && activeThumb.scrollIntoView) {
          activeThumb.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
      } else {
        thumbsContainer.classList.add('hidden');
        thumbsContainer.innerHTML = '';
      }
    }

    // Synchronize parent carousel if linked
    if (state.cId && typeof window._carouselGoTo === 'function') {
      window._carouselGoTo(state.cId, currentIdx);
    }
  }

  function lightboxPrev() {
    const state = window._lightboxState;
    if (!state || !Array.isArray(state.photos) || state.photos.length <= 1) return;
    state.current = state.current > 0 ? state.current - 1 : state.photos.length - 1;
    updateLightboxView();
  }

  function lightboxNext() {
    const state = window._lightboxState;
    if (!state || !Array.isArray(state.photos) || state.photos.length <= 1) return;
    state.current = state.current < state.photos.length - 1 ? state.current + 1 : 0;
    updateLightboxView();
  }

  function lightboxGoTo(idx) {
    const state = window._lightboxState;
    if (!state || !Array.isArray(state.photos) || state.photos.length === 0) return;
    state.current = Math.max(0, Math.min(idx, state.photos.length - 1));
    updateLightboxView();
  }

  window._lightboxPrev = lightboxPrev;
  window._lightboxNext = lightboxNext;
  window._lightboxGoTo = lightboxGoTo;

  function openImageLightbox(photoUrlOrPhotos, title = 'Proof of Maintenance', initialIdx = 0, cId = null) {
    if (!photoUrlOrPhotos) return;
    injectImageLightboxModalHTML();

    let photos = [];
    if (Array.isArray(photoUrlOrPhotos)) {
      photos = photoUrlOrPhotos.map(resolvePhotoUrl).filter(Boolean);
    } else if (typeof photoUrlOrPhotos === 'string') {
      const resolved = resolvePhotoUrl(photoUrlOrPhotos);
      photos = resolved ? [resolved] : [];
    }
    if (photos.length === 0) return;

    const modal = document.getElementById('ecoImageLightboxModal');
    const titleEl = document.getElementById('ecoLightboxTitle');
    if (!modal) return;

    modal.style.zIndex = '500000';
    if (titleEl) titleEl.textContent = title;

    window._lightboxState = {
      photos,
      current: Math.max(0, Math.min(initialIdx, photos.length - 1)),
      title,
      cId
    };

    updateLightboxView();

    modal.classList.remove('hidden');
    modal.style.display = 'flex';
    requestAnimationFrame(() => {
      modal.classList.remove('opacity-0');
      modal.classList.add('opacity-100');
    });
  }
  window.openImageLightbox = openImageLightbox;

  function closeImageLightbox() {
    const modal = document.getElementById('ecoImageLightboxModal');
    if (!modal) return;

    modal.classList.add('opacity-0');
    modal.classList.remove('opacity-100');
    setTimeout(() => {
      modal.classList.add('hidden');
      modal.style.display = 'none';
      const img = document.getElementById('ecoLightboxImage');
      if (img) img.src = '';
      if (window._lightboxState && window._lightboxState.cId) {
        try { window._carouselGoTo(window._lightboxState.cId, window._lightboxState.current); } catch (_) { }
      }
    }, 150);
  }

  // ===================================================================
  // 3B. UNIFIED PHOTO CAROUSEL CONTROLLER (GLOBAL, RESILIENT)
  // ===================================================================
  window._carouselState = window._carouselState || {};

  window._carouselGoTo = function (cId, idx) {
    let state = window._carouselState[cId];
    if (!state && cId && cId.endsWith('_track')) state = window._carouselState[cId.replace(/_track$/, '')];
    if (!state && cId) state = window._carouselState[cId + '_track'];
    if (!state || !Array.isArray(state.photos) || state.photos.length === 0) return;

    state.current = Math.max(0, Math.min(idx, state.photos.length - 1));
    const baseId = cId.replace(/_track$/, '');
    const track = document.getElementById(`${baseId}_track`) || document.getElementById(baseId);
    if (track) {
      const trackEl = track.classList.contains('carousel-track') ? track : (track.querySelector('.carousel-track') || track);
      trackEl.style.transform = `translateX(-${state.current * 100}%)`;
    }

    const dotColor = state.dotColor || 'emerald';
    const activeClass = dotColor === 'rose' ? 'bg-rose-400 w-4' : 'bg-emerald-500 w-4';
    document.querySelectorAll(`[data-carousel-id="${baseId}"], [data-carousel-id="${baseId}_track"]`).forEach((dot, i) => {
      dot.className = `carousel-dot w-2 h-2 rounded-full transition-all ${i === state.current ? activeClass : 'bg-white/40 hover:bg-white/70'}`;
    });
  };

  window._carouselPrev = function (cId) {
    let state = window._carouselState[cId];
    if (!state && cId && cId.endsWith('_track')) state = window._carouselState[cId.replace(/_track$/, '')];
    if (!state && cId) state = window._carouselState[cId + '_track'];
    if (!state || !Array.isArray(state.photos) || state.photos.length === 0) return;
    const newIdx = state.current > 0 ? state.current - 1 : state.photos.length - 1;
    window._carouselGoTo(cId, newIdx);
  };

  window._carouselNext = function (cId) {
    let state = window._carouselState[cId];
    if (!state && cId && cId.endsWith('_track')) state = window._carouselState[cId.replace(/_track$/, '')];
    if (!state && cId) state = window._carouselState[cId + '_track'];
    if (!state || !Array.isArray(state.photos) || state.photos.length === 0) return;
    const newIdx = state.current < state.photos.length - 1 ? state.current + 1 : 0;
    window._carouselGoTo(cId, newIdx);
  };

  window._carouselOpen = function (cId, idx) {
    let state = window._carouselState[cId];
    if (!state && cId && cId.endsWith('_track')) state = window._carouselState[cId.replace(/_track$/, '')];
    if (!state && cId) state = window._carouselState[cId + '_track'];
    if (!state || !Array.isArray(state.photos) || state.photos.length === 0) return;

    const photoIdx = (typeof idx === 'number' && !isNaN(idx)) ? idx : (state.current || 0);
    const title = state.title || 'Proof of Maintenance';
    openImageLightbox(state.photos, title, photoIdx, cId);
  };

  function openChecklistItemModal(reportId, taskId) {
    console.log('[EcoTrack] openChecklistItemModal called with reportId:', reportId, 'taskId:', taskId);
    activeChecklistReportId = reportId;
    activeChecklistTaskId = taskId;

    let modal = document.getElementById('ecoChecklistItemModal');
    if (!modal) {
      injectChecklistItemModalHTML();
      modal = document.getElementById('ecoChecklistItemModal');
    }
    if (!modal) {
      console.error('[EcoTrack] ecoChecklistItemModal element could not be found or created');
      return;
    }

    const reports = getReports();
    let report = findReportById(reports, reportId) || findReportById(reports, currentDetailId) || reports[0];
    if (!report) {
      console.warn('[EcoTrack] openChecklistItemModal: No report found for ID:', reportId);
      return;
    }

    // STRICT ISOLATION: Rework reports (RWK) must NEVER access standard checklist modal (ecoChecklistItemModal)
    // Only MR (Routine/Preventive) and REP (Corrective Repair) reports use ecoChecklistItemModal.
    const isRework = (report.id && String(report.id).toUpperCase().startsWith('RWK')) ||
                     report.type === 'Maintenance Rework' ||
                     Boolean(report.isRework);
    if (isRework) {
      console.log('[EcoTrack] Redirecting rework report task to dedicated ecoReworkTaskModal:', report.id, taskId);
      openReworkTaskModal(report.id, taskId);
      return;
    }

    if (!Array.isArray(report.tasks) || report.tasks.length === 0) {
      report.tasks = [
        { id: 1, name: 'Aircon Cleaning', status: 'Not Started', notes: '', updated: 'Today' },
        { id: 2, name: 'Filter Cleaning', status: 'Not Started', notes: '', updated: 'Today' },
        { id: 3, name: 'Temperature Control Inspection', status: 'Not Started', notes: '', updated: 'Today' },
        { id: 4, name: 'Air Pressure Control Inspection', status: 'Not Started', notes: '', updated: 'Today' },
        { id: 5, name: 'Energy Control Inspection', status: 'Not Started', notes: '', updated: 'Today' }
      ];
    }

    // Resilient task lookup: match by id (number or string), index, or name
    const numIdx = parseInt(taskId, 10);
    let task = report.tasks.find(t =>
      (t.id !== undefined && t.id !== null && (String(t.id) === String(taskId) || t.id == taskId)) ||
      (t.name && taskId && String(t.name).trim().toLowerCase() === String(taskId).trim().toLowerCase())
    );
    if (!task && !isNaN(numIdx) && numIdx > 0 && report.tasks[numIdx - 1]) {
      task = report.tasks[numIdx - 1];
    }
    if (!task && report.tasks.length > 0) {
      task = report.tasks[0];
    }
    if (!task) {
      task = { id: 1, name: String(taskId || 'Checklist Item'), status: 'Not Started', notes: '', updated: 'Today' };
      report.tasks.push(task);
    }

    activeChecklistStatus = task.status || 'Not Started';
    activeChecklistPhoto = task.photo || null;

    try {
      renderChecklistItemModalContent(report, task);
    } catch (err) {
      console.error('[EcoTrack] Error rendering checklist item modal content:', err);
    }

    modal.classList.remove('hidden');
    modal.style.display = 'flex';
    modal.style.zIndex = '100000';
    document.body.style.overflow = 'hidden';

    // Live background query to ensure fresh photo proof & notes from Supabase
    const sb = getSb();
    if (sb && reportId) {
      sb.from('maintenance_reports').select('*').eq('id', reportId).maybeSingle().then(({ data, error }) => {
        if (!error && data) {
          const fresh = normalizeReport(data);
          if (fresh) {
            const idx = _reportsCache.findIndex(r => String(r.id) === String(reportId));
            if (idx !== -1) _reportsCache[idx] = fresh;
            else _reportsCache.unshift(fresh);

            if (activeChecklistReportId === reportId) {
              const freshTask = fresh.tasks.find(t =>
                (t.id !== undefined && t.id !== null && (String(t.id) === String(activeChecklistTaskId) || t.id == activeChecklistTaskId)) ||
                (t.name && activeChecklistTaskId && String(t.name).trim().toLowerCase() === String(activeChecklistTaskId).trim().toLowerCase())
              ) || (!isNaN(numIdx) && numIdx > 0 && fresh.tasks[numIdx - 1]) || fresh.tasks[0];
              if (freshTask) {
                renderChecklistItemModalContent(fresh, freshTask);
              }
            }
          }
        }
      }).catch(err => console.warn('[openChecklistItemModal live fetch warn]:', err));
    }
  }

  function renderChecklistItemModalContent(report, task) {
    const header = document.getElementById('ecoChecklistItemModalHeader');
    const body = document.getElementById('ecoChecklistItemModalBody');
    const footer = document.getElementById('ecoChecklistItemModalFooter');
    if (!header || !body || !footer) return;

    const reportsList = getReports();
    const repairReport = getRepairReportForTask(report, task, reportsList) || (task.linkedRepairId ? findReportById(reportsList, task.linkedRepairId) : null);
    const isRepairDone = isRepairReportDone(repairReport) || Boolean(task.repaired);
    const isRepairVerified = isRepairReportVerified(repairReport) || Boolean(task.repaired && task.verified);
    const isThisTaskDefect = Boolean(
      (task.linkedRepairId && (!repairReport || repairReport.id === task.linkedRepairId)) ||
      (report.issue && isComponentInIssue(task.name, report.issue)) ||
      (repairReport && repairReport.issue && isComponentInIssue(task.name, repairReport.issue)) ||
      (repairReport && Array.isArray(repairReport.tasks) && repairReport.tasks.some(rt => isComponentInIssue(task.name, { component: rt.name })))
    );

    const isRepReport = isActualRepairTask(report);
    const isUnderRepair = !isRepReport && Boolean(
      !isRepairDone && !task.repaired && task.status !== 'Completed' && (
        (task.linkedRepairId && !task.repaired) ||
        (repairReport && !isRepairDone) ||
        (task.status === 'Under Repair' && Boolean(task.linkedRepairId || repairReport))
      )
    );
    const isNeedsRepair = !isRepReport && !isRepairDone && !isUnderRepair && !task.repaired && task.status !== 'Completed' && (
      task.status === 'Needs Repair' ||
      (report.issue && isThisTaskDefect && !report.issue.repaired)
    );

    // Header (Repaired, Under Repair In Progress, Issue View, or Standard Checklist View)
    if (isRepairDone) {
      header.innerHTML = `
        <div class="flex-1 pr-3">
          <div class="text-[11px] font-extrabold text-emerald-600 dark:text-emerald-400 uppercase tracking-wider flex items-center gap-1.5">
            <svg class="w-3.5 h-3.5 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>
            <span>CORRECTIVE REPAIR COMPLETED</span>
          </div>
          <div class="flex items-center flex-wrap gap-2 mt-0.5">
            <h3 class="text-xl font-bold text-[#18392B] dark:text-white tracking-tight">
              ${task.name}
            </h3>
            <span class="px-2.5 py-0.5 text-[10px] font-bold rounded-full bg-emerald-100 dark:bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 border border-emerald-400/40 shrink-0">
              REPAIRED ✓
            </span>
            ${repairReport ? `
              <span class="px-2 py-0.5 text-[10px] font-mono font-bold rounded-full bg-emerald-600 text-white shadow-xs">
                Repair Task: ${repairReport.id}
              </span>
            ` : (report.linkedRepairId ? `
              <span class="px-2 py-0.5 text-[10px] font-mono font-bold rounded-full bg-emerald-600 text-white shadow-xs">
                Repair Task: ${report.linkedRepairId}
              </span>
            ` : '')}
          </div>
        </div>
        <button type="button" id="btnCloseChecklistItemModal" class="w-8 h-8 rounded-full bg-gray-100 dark:bg-white/10 hover:bg-gray-200 dark:hover:bg-white/20 text-gray-500 dark:text-gray-300 flex items-center justify-center font-bold text-sm cursor-pointer transition-colors shrink-0">
          ✕
        </button>
      `;
    } else if (isUnderRepair) {
      const activeRepairId = (repairReport && repairReport.id) || task.linkedRepairId || null;
      header.innerHTML = `
        <div class="flex-1 pr-3">
          <div class="text-[11px] font-extrabold text-cyan-600 dark:text-cyan-400 uppercase tracking-wider flex items-center gap-1.5">
            <span class="w-2 h-2 rounded-full bg-cyan-500 animate-pulse"></span>
            <span>Maintenance Checklist Item • Under Repair</span>
          </div>
          <div class="flex items-center flex-wrap gap-2 mt-0.5">
            <h3 class="text-xl font-bold text-[#18392B] dark:text-white tracking-tight">
              ${task.name}
            </h3>
            <span class="px-2.5 py-0.5 text-[10px] font-bold font-mono rounded-full bg-cyan-100 dark:bg-cyan-500/20 text-cyan-800 dark:text-cyan-300 border border-cyan-400/50 shrink-0 uppercase">
              Under Repair ${activeRepairId ? `(${activeRepairId})` : ''}
            </span>
          </div>
        </div>
        <button type="button" id="btnCloseChecklistItemModal" class="w-8 h-8 rounded-full bg-gray-100 dark:bg-white/10 hover:bg-gray-200 dark:hover:bg-white/20 text-gray-500 dark:text-gray-300 flex items-center justify-center font-bold text-sm cursor-pointer transition-colors shrink-0">
          ✕
        </button>
      `;
    } else if (isNeedsRepair) {
      header.innerHTML = `
        <div class="flex-1 pr-3">
          <div class="text-[11px] font-extrabold text-rose-600 dark:text-rose-400 uppercase tracking-wider flex items-center gap-1.5">
            <svg class="w-3.5 h-3.5 text-rose-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
            <span>MAINTENANCE ISSUE DETECTED</span>
          </div>
          <div class="flex items-center flex-wrap gap-2 mt-0.5">
            <h3 class="text-xl font-bold text-[#18392B] dark:text-white tracking-tight">
              ${task.name}
            </h3>
            <span class="px-2.5 py-0.5 text-[10px] font-bold rounded-full bg-rose-100 dark:bg-rose-500/20 text-rose-800 dark:text-rose-300 border border-rose-400/40 shrink-0">
              NEEDS REPAIR
            </span>
            ${report.linkedRepairId ? `
              <span class="px-2 py-0.5 text-[10px] font-mono font-bold rounded-full bg-rose-600 text-white shadow-xs">
                Repair Task: ${report.linkedRepairId}
              </span>
            ` : ''}
          </div>
        </div>
        <button type="button" id="btnCloseChecklistItemModal" class="w-8 h-8 rounded-full bg-gray-100 dark:bg-white/10 hover:bg-gray-200 dark:hover:bg-white/20 text-gray-500 dark:text-gray-300 flex items-center justify-center font-bold text-sm cursor-pointer transition-colors shrink-0">
          ✕
        </button>
      `;
    } else if (isRepReport) {
      header.innerHTML = `
        <div class="flex-1 pr-3">
          <div class="text-[11px] font-extrabold text-rose-600 dark:text-rose-400 uppercase tracking-wider flex items-center gap-1.5">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>
            <span>CORRECTIVE REMEDIATION STEP</span>
          </div>
          <div class="flex items-center flex-wrap gap-2 mt-0.5">
            <h3 class="text-xl font-bold text-[#18392B] dark:text-white tracking-tight">
              ${task.name}
            </h3>
            <span class="px-2.5 py-0.5 text-[10px] font-bold rounded-full ${(task.verified || task.status === 'Completed' || task.repaired) ? 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 border border-emerald-400/40' : (task.status === 'In Progress' ? 'bg-cyan-100 dark:bg-cyan-500/20 text-cyan-800 dark:text-cyan-300 border border-cyan-400/40' : 'bg-rose-100 dark:bg-rose-500/20 text-rose-800 dark:text-rose-300 border border-rose-400/40')} shrink-0">
              ${(task.verified || task.status === 'Completed' || task.repaired) ? 'COMPLETED' : (task.status || 'Not Started')}
            </span>
            <span class="px-2 py-0.5 text-[10px] font-mono font-bold rounded-full bg-rose-600 text-white shadow-xs">
              ${report.id}
            </span>
          </div>
        </div>
        <button type="button" id="btnCloseChecklistItemModal" class="w-8 h-8 rounded-full bg-gray-100 dark:bg-white/10 hover:bg-gray-200 dark:hover:bg-white/20 text-gray-500 dark:text-gray-300 flex items-center justify-center font-bold text-sm cursor-pointer transition-colors shrink-0">
          ✕
        </button>
      `;
    } else {
      header.innerHTML = `
        <div class="flex-1 pr-3">
          <div class="text-[11px] font-extrabold text-[#10b981] dark:text-emerald-400 uppercase tracking-wider">
            MAINTENANCE CHECKLIST ITEM
          </div>
          <div class="flex items-center flex-wrap gap-2 mt-0.5">
            <h3 class="text-xl font-bold text-[#18392B] dark:text-white tracking-tight">
              ${task.name}
            </h3>
            ${(task.verified || task.status === 'Completed') ? `
              <span class="inline-flex items-center gap-1 px-2.5 py-0.5 text-[10px] font-bold rounded-full bg-emerald-100 dark:bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 border border-emerald-400/40 shrink-0 shadow-xs">
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>
                Completed
              </span>
            ` : ''}
          </div>
        </div>
        <button type="button" id="btnCloseChecklistItemModal" class="w-8 h-8 rounded-full bg-gray-100 dark:bg-white/10 hover:bg-gray-200 dark:hover:bg-white/20 text-gray-500 dark:text-gray-300 flex items-center justify-center font-bold text-sm cursor-pointer transition-colors shrink-0">
          ✕
        </button>
      `;
    }
    document.getElementById('btnCloseChecklistItemModal')?.addEventListener('click', closeChecklistItemModal);

    // Status Output Configuration
    let statusBorderClass = 'border-gray-200 dark:border-white/10';
    let statusBgClass = 'eco-status-neutral bg-gray-50 dark:bg-slate-900/60';
    let statusTextClass = 'text-gray-700 dark:text-gray-300';
    let statusDot = '<span class="w-3 h-3 rounded-full bg-gray-400 dark:bg-gray-500 shrink-0"></span>';

    if (task.status === 'Completed' || (task.repaired && isRepairDone)) {
      statusBorderClass = 'border-emerald-400/60 dark:border-emerald-500/50';
      statusBgClass = 'eco-status-success bg-emerald-50/70 dark:bg-emerald-950/40';
      statusTextClass = 'text-emerald-800 dark:text-emerald-300';
      statusDot = '<span class="w-3 h-3 rounded-full bg-emerald-500 shadow-sm shadow-emerald-500/50 shrink-0"></span>';
    } else if (isUnderRepair || task.status === 'Under Repair') {
      statusBorderClass = 'border-cyan-400/60 dark:border-cyan-500/50';
      statusBgClass = 'eco-status-info bg-cyan-50/70 dark:bg-cyan-950/40';
      statusTextClass = 'text-cyan-800 dark:text-cyan-300';
      statusDot = '<span class="w-3 h-3 rounded-full bg-cyan-500 animate-pulse shrink-0"></span>';
    } else if (task.status === 'Needs Repair' || isNeedsRepair) {
      statusBorderClass = 'border-rose-400/60 dark:border-rose-500/50';
      statusBgClass = 'eco-status-danger bg-rose-50/70 dark:bg-rose-950/40';
      statusTextClass = 'text-rose-800 dark:text-rose-300';
      statusDot = '<span class="w-3 h-3 rounded-full bg-rose-600 animate-pulse shrink-0"></span>';
    } else if (task.status === 'In Progress') {
      statusBorderClass = 'border-cyan-400/60 dark:border-cyan-500/50';
      statusBgClass = 'eco-status-info bg-cyan-50/70 dark:bg-cyan-950/40';
      statusTextClass = 'text-cyan-800 dark:text-cyan-300';
      statusDot = '<span class="w-3 h-3 rounded-full bg-cyan-500 shrink-0"></span>';
    }

    // Build full photo carousel — collect ALL unique photos belonging to THIS specific task
    // (If task is 'Not Started', technician has not started or captured any proof photos yet)
    const _allRawPhotos = new Set();
    const _pushPhoto = (p) => {
      if (!p) return;
      if (Array.isArray(p)) {
        p.forEach(item => _pushPhoto(item));
        return;
      }
      if (typeof p === 'string') {
        const trimmed = p.trim();
        if (!trimmed) return;
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
              parsed.forEach(item => _pushPhoto(item));
              return;
            }
          } catch (e) { }
        }
        if (trimmed.includes(',') && !trimmed.startsWith('data:')) {
          trimmed.split(',').forEach(sub => _pushPhoto(sub.trim()));
          return;
        }
        const r = resolvePhotoUrl(trimmed);
        if (r) _allRawPhotos.add(r);
        return;
      }
      if (typeof p === 'object') {
        const u = p.uri || p.url || p.photoUri || p.photo || p.imageUrl || p.src;
        if (u) _pushPhoto(u);
      }
    };

    // Only gather proof photos if task has actually been started or worked on
    if (task.status !== 'Not Started') {
      // 1. Own task photos
      if (task.photoUris) _pushPhoto(task.photoUris);
      if (task.photos) _pushPhoto(task.photos);
      if (task.images) _pushPhoto(task.images);
      if (task.attachments) _pushPhoto(task.attachments);
      _pushPhoto(task.photo || task.photoUri || task.photo_uri || task.photoUrl || task.photo_url || task.image || task.imageUrl || task.uri);

      // Defect / parent fallbacks are ONLY for standard preventive checklist items (NOT for corrective repair order steps)
      if (!isRepReport) {
        // 2. Issue photos (ONLY fallback if this task has NO photos of its own and issue is specifically for this single component)
        if (_allRawPhotos.size === 0 && report && report.issue && isComponentInIssue(task.name, report.issue)) {
          const isMultiComponentIssue = (Array.isArray(report.issue.components) && report.issue.components.length > 1) ||
            (typeof report.issue.component === 'string' && report.issue.component.split(/[,;/]+/).filter(Boolean).length > 1);
          if (!isMultiComponentIssue && task.status === 'Needs Repair') {
            if (report.issue.photoUris) _pushPhoto(report.issue.photoUris);
            if (report.issue.photos) _pushPhoto(report.issue.photos);
            if (report.issue.images) _pushPhoto(report.issue.images);
            _pushPhoto(report.issue.photoUri || report.issue.photo || report.issue.photo_url || report.issue.photoUrl || report.issue.image);
          }
        }

        // 3. Repair report photos (ONLY for matching repair tasks)
        const _repRep = getRepairReportFor(report, reportsList);
        if (_repRep && Array.isArray(_repRep.tasks)) {
          const _curN = String(task.name || '').toLowerCase().trim();
          _repRep.tasks.forEach(rt => {
            const rtN = String(rt.name || '').toLowerCase().trim();
            if (rtN && _curN && (rtN === _curN || rtN.includes(_curN) || _curN.includes(rtN))) {
              if (rt.photoUris) _pushPhoto(rt.photoUris);
              if (rt.photos) _pushPhoto(rt.photos);
              _pushPhoto(rt.photo || rt.photoUri);
            }
          });
        }

        // 4. Parent report defect photo fallback (ONLY if component or task name strictly matches)
        if (_allRawPhotos.size === 0 && report && (report.parentReportId || report.linkedParentId || (typeof report.description === 'string' && report.description.includes('Linked to')))) {
          const parentId = report.parentReportId || report.linkedParentId || (report.description?.match(/Linked to\s+([\w-]+)/i)?.[1]);
          const parentRep = findReportById(reportsList, parentId);
          if (parentRep) {
            const curName = String(task.name || '').toLowerCase().trim();
            if (Array.isArray(parentRep.tasks)) {
              parentRep.tasks.forEach(pt => {
                const ptName = String(pt.name || '').toLowerCase().trim();
                if (ptName === curName) {
                  if (pt.photoUris) _pushPhoto(pt.photoUris);
                  if (pt.photos) _pushPhoto(pt.photos);
                  _pushPhoto(pt.photo || pt.photoUri);
                }
              });
            }
            if (_allRawPhotos.size === 0 && parentRep.issue && isComponentInIssue(task.name, parentRep.issue)) {
              const isMulti = (Array.isArray(parentRep.issue.components) && parentRep.issue.components.length > 1) ||
                (typeof parentRep.issue.component === 'string' && parentRep.issue.component.split(/[,;/]+/).filter(Boolean).length > 1);
              if (!isMulti && task.status === 'Needs Repair') {
                if (parentRep.issue.photoUris) _pushPhoto(parentRep.issue.photoUris);
                if (parentRep.issue.photos) _pushPhoto(parentRep.issue.photos);
                _pushPhoto(parentRep.issue.photoUri || parentRep.issue.photo || parentRep.issue.photo_url);
              }
            }
          }
        }
      }
    }

    const allPhotos = Array.from(_allRawPhotos).filter(Boolean);

    // Helper: build photo carousel HTML
    const buildPhotoCarousel = (photos, label) => {
      const resolvedList = (photos || []).map(resolvePhotoUrl).filter(Boolean);
      if (resolvedList.length === 0) return `
        <div class="border border-dashed border-gray-200 dark:border-white/10 rounded-2xl p-6 text-center bg-gray-50/50 dark:bg-slate-950/40">
          <div class="w-10 h-10 rounded-full bg-gray-100 dark:bg-white/5 text-gray-400 dark:text-gray-500 flex items-center justify-center mx-auto mb-2">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          </div>
          <span class="text-xs text-gray-600 dark:text-gray-400 block font-medium">No photo proof attached</span>
          <span class="text-[10px] text-gray-400 dark:text-gray-500 block mt-0.5">${task.status === 'Not Started' ? 'Technician has not started or captured images for this step yet' : 'Technician did not capture an image for this item'}</span>
        </div>`;

      const carouselId = `photoCarousel_${Date.now()}`;
      const dots = resolvedList.length > 1 ? resolvedList.map((_, i) => `
        <button data-carousel-id="${carouselId}" data-idx="${i}" class="carousel-dot w-2 h-2 rounded-full transition-all ${i === 0 ? 'bg-emerald-500 w-4' : 'bg-white/40 hover:bg-white/70'}" onclick="window._carouselGoTo && window._carouselGoTo('${carouselId}',${i})"></button>
      `).join('') : '';

      const slides = resolvedList.map((photo, i) => `
        <div class="carousel-slide shrink-0 w-full" data-slide="${i}">
          <div class="maintenance-photo-preview cursor-pointer relative overflow-hidden flex items-center justify-center bg-gray-100/90 dark:bg-[#040914] min-h-[140px] p-2 select-none" title="Click to view fullscreen" onclick="window._carouselOpen && window._carouselOpen('${carouselId}',${i})">
            <img src="${photo}" data-raw="${photo}" alt="Photo ${i + 1}" class="w-full max-h-56 sm:max-h-60 object-contain rounded-xl pointer-events-none select-none" onerror="window.handleCarouselPhotoError ? window.handleCarouselPhotoError(this, ${i + 1}) : (this.onerror=null, this.parentElement.innerHTML='<div class=\\'p-4 text-center text-xs text-rose-400 font-medium\\'>Unable to display image preview</div>');">
            <div class="maintenance-photo-overlay">
              <span class="px-3.5 py-2 bg-black/85 backdrop-blur-md rounded-xl text-white text-xs font-bold shadow-lg flex items-center gap-1.5 border border-white/20 select-none pointer-events-none">
                <svg class="w-4 h-4 text-emerald-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7"/></svg>
                <span>View Fullscreen</span>
              </span>
            </div>
            ${resolvedList.length > 1 ? `<span class="absolute top-2 right-2 px-2 py-0.5 text-[10px] font-mono font-bold rounded-full bg-black/60 text-white backdrop-blur-sm border border-white/20 pointer-events-none z-10">${i + 1}/${resolvedList.length}</span>` : ''}
          </div>
        </div>
      `).join('');

      const prevBtn = resolvedList.length > 1 ? `
        <button class="carousel-prev absolute left-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-black/50 hover:bg-black/75 backdrop-blur-sm border border-white/20 text-white flex items-center justify-center z-10 transition-all cursor-pointer shadow-md" onclick="window._carouselPrev && window._carouselPrev('${carouselId}')">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M15 19l-7-7 7-7"/></svg>
        </button>
        <button class="carousel-next absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-black/50 hover:bg-black/75 backdrop-blur-sm border border-white/20 text-white flex items-center justify-center z-10 transition-all cursor-pointer shadow-md" onclick="window._carouselNext && window._carouselNext('${carouselId}')">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7"/></svg>
        </button>` : '';

      return `
        <div class="maintenance-photo-card rounded-2xl overflow-hidden border border-gray-200 dark:border-white/10 shadow-sm bg-gray-50 dark:bg-[#081326] group relative">
          <!-- Carousel Track -->
          <div class="carousel-wrapper relative overflow-hidden" id="${carouselId}">
            <div class="carousel-track flex transition-transform duration-300 ease-in-out" id="${carouselId}_track">
              ${slides}
            </div>
            ${prevBtn}
            ${photos.length > 1 ? `<div class="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1 z-10">${dots}</div>` : ''}
          </div>
          <!-- Bottom Bar -->
          <div class="maintenance-photo-bar p-2.5 sm:p-3 bg-white dark:bg-[#0c1830] border-t border-gray-200 dark:border-white/10 flex items-center justify-between text-xs">
            <span class="flex items-center gap-1.5 font-semibold text-xs text-gray-700 dark:text-gray-200">
              <svg class="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/><circle cx="12" cy="13" r="3"/></svg>
              <span>${label || 'Photo of detected defect'}</span>
              ${photos.length > 1 ? `<span class="px-1.5 py-0.5 text-[9px] font-bold rounded-full bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300 border border-emerald-400/40">${photos.length} photos</span>` : ''}
            </span>
            <button type="button" id="btnChecklistPhotoOpenFull" data-carousel-id="${carouselId}" class="maintenance-photo-btn font-bold underline cursor-pointer bg-transparent border-0 p-0 text-xs flex items-center gap-1 text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300 transition-colors">
              <span>View Full Size ↗</span>
            </button>
          </div>
        </div>`;
    };

    // Body (Matches First Image when Needs Repair, Under Repair view when under repair, otherwise Standard Checklist View)
    if (isNeedsRepair) {
      body.innerHTML = `
        <!-- Maintenance Issue Detected Banner (Matches First Image) -->
        <div class="bg-rose-50 dark:bg-rose-950/30 border-2 border-rose-500/50 rounded-2xl p-4 shadow-sm space-y-3">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2 text-rose-600 dark:text-rose-400 font-bold text-xs uppercase tracking-wider">
              <svg class="w-4 h-4 text-rose-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
              <span>Maintenance Issue Detected</span>
            </div>
            ${report.linkedRepairId ? `
              <span class="px-2 py-0.5 text-[10px] font-mono font-bold rounded-full bg-rose-600 text-white shadow-xs">
                Repair Task: ${report.linkedRepairId}
              </span>
            ` : ''}
          </div>

          <div class="bg-white dark:bg-slate-950/70 border border-rose-300 dark:border-rose-500/30 rounded-xl p-3 shadow-sm">
            <div class="flex items-center justify-between mb-1">
              <span class="font-bold text-gray-800 dark:text-white text-sm">${task.name}</span>
              <span class="px-2 py-0.5 text-[10px] font-bold rounded-full bg-rose-100 dark:bg-rose-500/20 text-rose-700 dark:text-rose-400 border border-rose-400/40">NEEDS REPAIR</span>
            </div>
            <p class="text-gray-600 dark:text-gray-300 font-medium text-xs leading-relaxed italic">
              "${task.notes && task.notes.trim() ? task.notes.trim() : 'Maintenance defect requires repair'}"
            </p>
          </div>
        </div>

        <!-- Proof of Defect / Maintenance (Photo Output) -->
        <div class="space-y-1.5">
          <div class="flex items-center justify-between">
            <label class="text-xs font-bold text-gray-700 dark:text-gray-300">Proof of Maintenance (Photo):</label>
            ${allPhotos.length > 0 ? `<span class="text-[10px] text-emerald-600 dark:text-emerald-400 font-bold">✓ ${allPhotos.length > 1 ? allPhotos.length + ' Photos Attached' : 'Photo Attached'}</span>` : `<span class="text-[10px] text-gray-400 dark:text-gray-500">No Photo</span>`}
          </div>
          ${buildPhotoCarousel(allPhotos, 'Photo of detected defect')}
        </div>
      `;
    } else if (isUnderRepair) {
      // Under Repair view (matches Image 2 requested flow)
      const rId = (repairReport && repairReport.id) || task.linkedRepairId || report.linkedRepairId;
      const techName = (repairReport && repairReport.staffName) || report.staffName || 'Technician';

      body.innerHTML = `
        <!-- Status Output -->
        <div class="space-y-1.5">
          <label class="block text-xs font-bold text-gray-700 dark:text-gray-300">Status:</label>
          <div class="p-3 sm:p-3.5 rounded-2xl border ${statusBorderClass} ${statusBgClass} flex flex-wrap items-center justify-between gap-2 shadow-xs">
            <div class="flex items-center gap-2 flex-wrap min-w-0">
              ${statusDot}
              <span class="eco-status-info text-sm font-black ${statusTextClass} whitespace-nowrap">Under Repair</span>
              ${rId ? `<span class="px-2 py-0.5 text-[10px] font-mono font-bold rounded-full bg-cyan-100 dark:bg-cyan-900/60 text-cyan-800 dark:text-cyan-200 border border-cyan-400/50 shrink-0">Task: ${rId}</span>` : ''}
            </div>
            <span class="text-[11px] font-mono text-gray-500 dark:text-gray-400 font-medium shrink-0 ml-auto">Updated: ${task.updated || 'Just now'}</span>
          </div>
        </div>

        <!-- Repair Assignment Info -->
        <div class="space-y-1.5">
          <label class="block text-xs font-bold text-cyan-700 dark:text-cyan-400">Repair Assignment:</label>
          <div class="bg-cyan-50/60 dark:bg-[#08182b] border border-cyan-300 dark:border-cyan-500/40 rounded-2xl p-3.5 shadow-xs">
            <div class="flex items-center justify-between mb-1">
              <span class="font-bold text-gray-800 dark:text-white text-xs">Technician ${techName}</span>
              <span class="px-2 py-0.5 text-[10px] font-bold rounded-full bg-cyan-100 dark:bg-cyan-500/20 text-cyan-800 dark:text-cyan-300 border border-cyan-400/50 uppercase">${(repairReport && repairReport.status) || 'IN PROGRESS'}</span>
            </div>
            <p class="text-xs text-gray-700 dark:text-gray-300 font-medium leading-relaxed italic">
              "Technician ${techName} is currently performing corrective repair for this defect."
            </p>
          </div>
        </div>

        <!-- Worker Remarks Output -->
        <div class="space-y-1.5">
          <label class="block text-xs font-bold text-gray-700 dark:text-gray-300">Worker Remarks:</label>
          <div class="bg-gray-50 dark:bg-[#081326] border border-gray-200 dark:border-white/10 rounded-2xl p-3.5 shadow-xs">
            <p class="text-xs text-gray-800 dark:text-gray-100 font-medium leading-relaxed italic">
              "${task.notes && task.notes.trim() ? task.notes.trim() : 'Maintenance defect requires repair'}"
            </p>
          </div>
        </div>

        <!-- Proof of Maintenance (Photo Output) -->
        <div class="space-y-1.5">
          <div class="flex items-center justify-between">
            <label class="text-xs font-bold text-gray-700 dark:text-gray-300">Proof of Maintenance (Photo):</label>
            ${allPhotos.length > 0 ? `<span class="text-[10px] text-emerald-600 dark:text-emerald-400 font-bold">✓ ${allPhotos.length > 1 ? allPhotos.length + ' Photos Attached' : 'Photo Attached'}</span>` : `<span class="text-[10px] text-gray-400 dark:text-gray-500">No Photo</span>`}
          </div>
          ${buildPhotoCarousel(allPhotos, 'Proof captured by technician')}
        </div>
      `;
    } else {
      // Normal Checklist Item view (Completed, Repaired, or In Progress)
      body.innerHTML = `
        <!-- Status Output -->
        <div class="space-y-1.5">
          <label class="block text-xs font-bold text-gray-700 dark:text-gray-300">Status:</label>
          <div class="p-3 sm:p-3.5 rounded-2xl border ${statusBorderClass} ${statusBgClass} flex items-center justify-between shadow-xs">
            <div class="flex items-center gap-2.5">
              ${statusDot}
              <span class="text-sm font-black ${statusTextClass}">${(task.repaired || isRepairDone) ? `${task.status === 'Needs Repair' || task.status === 'Under Repair' ? 'Completed' : task.status} (Repaired ✓)` : (task.status || 'Not Started')}</span>
              ${(task.repaired || isRepairDone) ? `<span class="px-2 py-0.5 text-[10px] font-mono font-bold rounded-full bg-emerald-100 dark:bg-emerald-900/60 text-emerald-800 dark:text-emerald-200 border border-emerald-400/50">Repaired via ${(repairReport && repairReport.id) || task.linkedRepairId || report.linkedRepairId || 'Corrective Order'}</span>` : ''}
            </div>
            <span class="text-[11px] font-mono text-gray-500 dark:text-gray-400 font-medium">Updated: ${task.updated || 'Today'}</span>
          </div>
        </div>

        <!-- Worker Remarks Output -->
        <div class="space-y-1.5">
          <label class="block text-xs font-bold text-gray-700 dark:text-gray-300">Worker Remarks:</label>
          <div class="bg-gray-50 dark:bg-[#081326] border border-gray-200 dark:border-white/10 rounded-2xl p-3.5 shadow-xs">
            ${task.notes && task.notes.trim() ? `
              <p class="text-xs text-gray-800 dark:text-gray-100 font-medium leading-relaxed italic">
                "${task.notes.trim()}"
              </p>
            ` : `
              <p class="text-xs text-gray-400 dark:text-gray-500 italic">
                No worker remarks submitted for this item.
              </p>
            `}
          </div>
        </div>

        <!-- Proof of Maintenance (Photo Output) -->
        <div class="space-y-1.5">
          <div class="flex items-center justify-between">
            <label class="text-xs font-bold text-gray-700 dark:text-gray-300">Proof of Maintenance (Photo):</label>
            ${allPhotos.length > 0 ? `<span class="text-[10px] text-emerald-600 dark:text-emerald-400 font-bold">✓ ${allPhotos.length > 1 ? allPhotos.length + ' Photos Attached' : 'Photo Attached'}</span>` : `<span class="text-[10px] text-gray-400 dark:text-gray-500">No Photo</span>`}
          </div>
          ${buildPhotoCarousel(allPhotos, (task.repaired || isRepairDone) ? 'Proof captured during repair' : 'Proof captured by technician')}
        </div>
      `;
    }

    // Footer actions
    const activeRepairId = (repairReport && repairReport.id) || task.linkedRepairId || null;

    if (isRepReport) {
      const isReadyForVerificationOrRework = task.verified || task.status === 'Completed' || task.repaired || isRepairDone;
      if (!isReadyForVerificationOrRework) {
        footer.innerHTML = `
          <div class="flex items-center justify-between gap-3 w-full">
            <button type="button" id="btnCancelChecklistItem" class="px-5 py-2.5 bg-gray-100 dark:bg-slate-800 hover:bg-gray-200 dark:hover:bg-slate-700 text-gray-700 dark:text-gray-300 font-bold text-xs rounded-2xl cursor-pointer transition-colors shrink-0">
              Close
            </button>
            <div class="flex items-center gap-2 flex-1 justify-end">
              <button type="button" disabled class="px-5 py-2.5 bg-cyan-50 dark:bg-cyan-950/50 text-cyan-700 dark:text-cyan-300 border border-cyan-400/50 rounded-2xl font-bold text-xs cursor-default flex items-center gap-2 select-none shadow-xs">
                <span class="w-2 h-2 rounded-full bg-cyan-500 animate-pulse"></span>
                <span>In Progress</span>
              </button>
            </div>
          </div>
        `;
      } else {
        footer.innerHTML = `
          <div class="flex items-center justify-between gap-3 w-full">
            <button type="button" id="btnCancelChecklistItem" class="px-5 py-2.5 bg-gray-100 dark:bg-slate-800 hover:bg-gray-200 dark:hover:bg-slate-700 text-gray-700 dark:text-gray-300 font-bold text-xs rounded-2xl cursor-pointer transition-colors shrink-0">
              Close
            </button>
            <div class="flex items-center gap-2 flex-1 justify-end">
              <button type="button" id="btnVerifyChecklistItem" class="px-5 py-2.5 ${task.verified ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-md' : 'bg-[#10b981] hover:bg-emerald-400 text-white shadow-md'} font-bold text-xs rounded-2xl cursor-pointer transition-all flex items-center justify-center gap-1.5 shadow-sm">
                <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>
                <span>${task.verified ? 'Verified (Click to Unverify)' : 'Verify Step'}</span>
              </button>
            </div>
          </div>
        `;
      }
    } else if (isUnderRepair && activeRepairId) {
      footer.innerHTML = `
        <div class="flex items-center justify-between gap-3 w-full">
          <button type="button" id="btnCancelChecklistItem" class="px-5 py-2.5 bg-gray-100 dark:bg-slate-800 hover:bg-gray-200 dark:hover:bg-slate-700 text-gray-700 dark:text-gray-300 font-bold text-xs rounded-2xl cursor-pointer transition-colors shrink-0">
            Close
          </button>
          <div class="flex items-center gap-2 flex-1 justify-end">
            <button type="button" id="btnChecklistViewRepair" style="background-color: #0891b2 !important; color: #ffffff !important;" class="px-5 py-2.5 bg-cyan-600 hover:bg-cyan-500 text-white font-bold text-xs rounded-2xl border-0 cursor-pointer transition-all shadow-md flex items-center gap-1.5" data-repair-id="${activeRepairId}">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" style="color: #ffffff !important; stroke: #ffffff !important;"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
              <span style="color: #ffffff !important;">Open Repair Task ${activeRepairId}</span>
            </button>
          </div>
        </div>
      `;
    } else if (isNeedsRepair || (isUnderRepair && !activeRepairId)) {
      footer.innerHTML = `
        <div class="flex items-center justify-between gap-3 w-full">
          <button type="button" id="btnCancelChecklistItem" class="px-5 py-2.5 bg-gray-100 dark:bg-slate-800 hover:bg-gray-200 dark:hover:bg-slate-700 text-gray-700 dark:text-gray-300 font-bold text-xs rounded-2xl cursor-pointer transition-colors shrink-0">
            Close
          </button>
          <div class="flex items-center gap-2 flex-1 justify-end">
            <button type="button" id="btnChecklistCreateRepair" class="px-5 py-2.5 bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs rounded-2xl border-0 cursor-pointer transition-all shadow-md flex items-center justify-center gap-1.5">
              <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"/></svg>
              <span>Create Repair Task</span>
            </button>
          </div>
        </div>
      `;
    } else {
      const isItemReadyForReview = task.verified || task.status === 'Completed' || task.repaired || isRepairDone || report.status === 'For Verification' || report.status === 'Completed';
      if (!isItemReadyForReview) {
        footer.innerHTML = `
          <div class="flex items-center justify-between gap-3 w-full">
            <button type="button" id="btnCancelChecklistItem" class="px-5 py-2.5 bg-gray-100 dark:bg-slate-800 hover:bg-gray-200 dark:hover:bg-slate-700 text-gray-700 dark:text-gray-300 font-bold text-xs rounded-2xl cursor-pointer transition-colors shrink-0">
              Close
            </button>
            <div class="flex items-center gap-2 flex-1 justify-end">
              <button type="button" disabled class="px-5 py-2.5 bg-cyan-50 dark:bg-cyan-950/50 text-cyan-700 dark:text-cyan-300 border border-cyan-400/50 rounded-2xl font-bold text-xs cursor-default flex items-center gap-2 select-none shadow-xs">
                <span class="w-2 h-2 rounded-full bg-cyan-500 animate-pulse"></span>
                <span>In Progress</span>
              </button>
            </div>
          </div>
        `;
      } else {
        footer.innerHTML = `
          <div class="flex items-center justify-between gap-3 w-full">
            <button type="button" id="btnCancelChecklistItem" class="px-5 py-2.5 bg-gray-100 dark:bg-slate-800 hover:bg-gray-200 dark:hover:bg-slate-700 text-gray-700 dark:text-gray-300 font-bold text-xs rounded-2xl cursor-pointer transition-colors shrink-0">
              Close
            </button>
            <div class="flex items-center gap-2 flex-1 justify-end">
              <button type="button" id="btnVerifyChecklistItem" class="px-5 py-2.5 ${task.verified ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-md' : 'bg-[#10b981] hover:bg-emerald-400 text-white shadow-md'} font-bold text-xs rounded-2xl cursor-pointer transition-all flex items-center justify-center gap-1.5 shadow-sm">
                <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>
                <span>${task.verified ? 'Verified (Click to Unverify)' : 'Verify Checklist Item'}</span>
              </button>
            </div>
          </div>
        `;
      }
    }

    document.getElementById('btnCancelChecklistItem')?.addEventListener('click', closeChecklistItemModal);

    // Wire up actions for Needs Repair items

    const triggerRepair = () => {
      if (!report.issue) report.issue = {};
      report.issue.component = task.name;
      report.issue.notes = task.notes || 'Maintenance defect requires repair.';
      if (Array.isArray(task.photoUris) && task.photoUris.length > 0) {
        report.issue.photoUris = [...task.photoUris];
        report.issue.photos = [...task.photoUris];
        report.issue.photoUri = task.photoUris[0];
      } else if (task.photo || task.photoUri) {
        const u = task.photo || task.photoUri;
        report.issue.photoUri = u;
        report.issue.photoUris = [u];
      }
      closeChecklistItemModal();
      openRepairTaskModal(report.id, task.id, task.name);
    };


    document.getElementById('btnChecklistCreateRepair')?.addEventListener('click', triggerRepair);

    document.getElementById('btnChecklistViewRepair')?.addEventListener('click', (e) => {
      const repId = e.currentTarget.getAttribute('data-repair-id');
      closeChecklistItemModal();
      if (repId) openDetailModal(repId);
    });

    // Wire up carousel controller (global functions keyed by carouselId)
    const photoTitle = `${task.name || 'Checklist Item'} — Proof of Maintenance`;

    if (allPhotos.length > 0) {
      window._carouselState = window._carouselState || {};

      // Register carousel state for all carousels in the modal body
      body.querySelectorAll('.carousel-wrapper').forEach(wrapper => {
        const cId = wrapper.id;
        if (cId) {
          window._carouselState[cId] = {
            current: 0,
            photos: allPhotos,
            title: photoTitle,
            dotColor: 'emerald'
          };
          window._carouselState[cId + '_track'] = window._carouselState[cId];
        }
      });

      // Wire "View Full Size" button to open the current carousel slide
      const openFullBtn = document.getElementById('btnChecklistPhotoOpenFull');
      if (openFullBtn) {
        openFullBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const cId = openFullBtn.getAttribute('data-carousel-id');
          const state = cId ? window._carouselState[cId] : null;
          const currentIdx = state ? state.current : 0;
          openImageLightbox(allPhotos, photoTitle, currentIdx, cId);
        });
      }
    }

    // Verify Action for standard and completed repair items
    document.getElementById('btnVerifyChecklistItem')?.addEventListener('click', async () => {
      task.verified = !task.verified;
      if (task.verified) {
        task.status = 'Completed';
        task.repaired = true;
        task.verifiedAt = new Date().toISOString();
        if (!report.timeline) report.timeline = [];
        report.timeline.unshift({ title: `Task "${task.name}" verified by Admin`, time: 'Just now', done: true, by: 'Admin' });
      }
      task.updated = 'Just now';

      // If child repairReport exists, synchronize its verification status
      if (repairReport && task.verified) {
        repairReport.status = 'Completed';
        repairReport.verified = true;
        if (Array.isArray(repairReport.tasks)) {
          repairReport.tasks.forEach(rt => {
            rt.status = 'Completed';
            rt.verified = true;
            if (!rt.verifiedAt) rt.verifiedAt = new Date().toISOString();
          });
        }
        if (!repairReport.timeline) repairReport.timeline = [];
        repairReport.timeline.unshift({
          title: `Repair ${repairReport.id} verified & signed off by Admin`,
          time: 'Just now',
          done: true,
          by: 'Admin'
        });
        await saveReports(reportsList, repairReport);
      }

      // Update overall report status
      if (isRepReport) {
        const repAllDone = report.tasks.every(t => t.status === 'Completed' || t.repaired);
        const repAllVerified = report.tasks.every(t => (t.status === 'Completed' || t.repaired) && t.verified);
        if (repAllVerified || repAllDone) report.status = 'Completed';
        else if (report.tasks.some(t => t.status === 'In Progress' || t.status === 'Completed')) report.status = 'In Progress';
        else report.status = 'Pending';

        if (report.parentReportId || report.linkedParentId) {
          const pRep = findReportById(reportsList, report.parentReportId || report.linkedParentId);
          if (pRep && Array.isArray(pRep.tasks)) {
            const pTask = pRep.tasks.find(pt => pt.linkedRepairId === report.id || (report.issue?.component && isComponentInIssue(pt.name, report.issue)));
            if (pTask) {
              if (repAllDone) pTask.repaired = true;
              if (repAllVerified) pTask.verified = true;
            }
          }
        }
      } else {
        const allDone = report.tasks.every(t => t.status === 'Completed' || t.repaired);
        const allVerified = report.tasks.every(t => (t.status === 'Completed' || t.repaired) && t.verified);
        const hasErr = report.tasks.some(t => t.status === 'Needs Repair' && !t.repaired);
        if (hasErr) {
          report.status = 'Needs Repair';
          const errTask = report.tasks.find(t => t.status === 'Needs Repair' && !t.repaired);
          if (errTask) {
            report.issue = {
              component: errTask.name,
              notes: errTask.notes || 'Maintenance defect requires repair.'
            };
          }
        } else {
          if (report.issue && !report.issue.repaired) {
            report.issue.repaired = true;
            report.issue.status = 'Repaired';
          }
          if (allVerified) report.status = 'Completed';
          else if (allDone) report.status = 'For Verification';
          else if (report.tasks.some(t => t.status === 'In Progress' || t.status === 'Completed')) report.status = 'In Progress';
          else report.status = 'Pending';
        }
      }

      await saveReports(getReports(), report);
      renderDetailModalContent();
      renderChecklistItemModalContent(report, task);
      showToast(task.verified ? 'Task Completed' : 'Task Incomplete', `"${task.name}" is now marked as ${task.verified ? 'Completed' : 'Incomplete'}.`, task.verified ? 'success' : 'info');
    });
  }

  // ===================================================================
  // 3B. REWORK CONTROLLERS REMOVED (STANDARDIZED TO REPAIR & MAINTENANCE)
  // ===================================================================
  function injectReworkModalHTML() {}
  function openReworkModal() {}
  function closeReworkModal() {}
  function renderReworkModalContent() {}
  function submitRework() {}
  function injectReworkTaskModalHTML() {}
  function openReworkTaskModal() {}
  function closeReworkTaskModal() {}
  function renderReworkTaskModalContent() {}

  // ===================================================================
  // 3C. CORRECTIVE REPAIR TASK MODAL CONTROLLER
  // ===================================================================

  let activeRepairReportId = null;
  let activeRepairReport = null;
  let activeRepairTaskId = null;
  let activeRepairTaskName = null;
  let _lastRenderedTaskId = null;
  let isSubmittingRepairTask = false;
  let activeRepairPriority = 'Critical';
  let activeRepairSteps = [];
  let editingRepairStepIdx = null;

  function injectRepairTaskModalHTML() {
    if (document.getElementById('ecoRepairTaskModal')) return;

    const modalHTML = `
      <div id="ecoRepairTaskModal" class="hidden fixed inset-0 bg-slate-950/75 backdrop-blur-sm z-[9999] flex items-center justify-center p-3 sm:p-4 transition-all">
        <div class="bg-white dark:bg-[#0c1328] border-2 border-rose-500/50 dark:border-rose-400/50 rounded-3xl w-full max-w-xl shadow-2xl flex flex-col overflow-hidden text-gray-800 dark:text-gray-100 transition-all max-h-[92vh]">
          <div id="ecoRepairTaskModalHeader" class="px-5 pt-5 pb-3 flex items-start justify-between border-b border-gray-100 dark:border-white/10 shrink-0">
            <!-- Injected by renderRepairTaskModalContent -->
          </div>
          <div id="ecoRepairTaskModalBody" class="p-5 overflow-y-auto eco-slim-scrollbar space-y-4 flex-1">
            <!-- Injected by renderRepairTaskModalContent -->
          </div>
          <div id="ecoRepairTaskModalFooter" class="px-5 py-3.5 bg-gray-50 dark:bg-slate-950/80 border-t border-gray-100 dark:border-white/10 flex items-center justify-between gap-2 shrink-0 relative z-20">
            <!-- Injected by renderRepairTaskModalContent -->
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHTML);

    const modal = document.getElementById('ecoRepairTaskModal');
    modal?.addEventListener('click', (e) => {
      if (e.target === modal) closeRepairTaskModal();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) {
        closeRepairTaskModal();
      }
    });
  }

  function closeRepairTaskModal() {
    const modal = document.getElementById('ecoRepairTaskModal');
    if (modal) {
      modal.classList.add('hidden');
      modal.style.display = 'none';
    }
    document.body.style.overflow = '';
    isSubmittingRepairTask = false;
    activeRepairReportId = null;
    activeRepairReport = null;
    activeRepairTaskId = null;
    activeRepairTaskName = null;
    _lastRenderedTaskId = null;
    refreshPageReportsView();
  }

  function getDefaultStepsToFix(componentName, defectNotes = '') {
    const raw = (String(componentName || '') + ' ' + String(defectNotes || '')).toLowerCase().trim();

    // 1. Cleaning / Dust / Filters / Drainage
    if (raw.includes('clean') || raw.includes('filter') || raw.includes('wash') || raw.includes('dirt') || raw.includes('drain')) {
      return [
        'Safety Isolation & Power Supply Lockout',
        'Disassemble Front Cover, Louvers, and Air Filter Mesh',
        'Deep Pressure Clean Evaporator Coil, Blower Fan, and Drain Pan',
        'Flush & Unclog Condensate Drainage Line',
        'Reassemble Unit, Restore Power, and Verify Clean Airflow & Cooling Performance'
      ];
    }

    // 2. Temperature Control / Thermistor
    if (raw.includes('temperature') || raw.includes('temp') || raw.includes('thermal') || raw.includes('thermistor')) {
      return [
        'Safety Isolation & Electrical Circuit Lockout',
        'Access Control Terminal & Measure Resistance/Continuity with Multimeter',
        'Replace Defective Temperature Control Probe and Secure Mounting Clip',
        'Calibrate Control Reading and Test Telemetry Response in Dashboard'
      ];
    }

    // 3. Pressure Control / Air Pressure / PS-802 / Pneumatics
    if (raw.includes('pressure') || raw.includes('ps-') || raw.includes('baro') || raw.includes('pneumatic')) {
      return [
        'Safety Isolation & Lock Out Power Circuit',
        'Inspect Pressure Control Tubing, Pneumatic Ports, and Cable Harness',
        'Clean Port & Replace Damaged Pressure Control Module (PS-802)',
        'Calibrate Zero-Point Offset & Verify Pressure Telemetry Under Operation'
      ];
    }

    // 4. Energy Control / CT / Current / Voltage / Power
    if (raw.includes('energy') || raw.includes('power') || raw.includes('current') || raw.includes('voltage') || raw.includes('watt') || raw.includes('ct control')) {
      return [
        'Electrical Lock-Out / Tag-Out (LOTO) & Verify Zero Voltage',
        'Inspect Current Transformer (CT) Clamps, Wiring, and Terminal Block',
        'Replace Faulty Energy Monitoring Control / Metering Transducer',
        'Restore Electrical Supply & Verify Real-Time Current, Voltage, and kWh Telemetry'
      ];
    }

    // 5. Compressor / Refrigerant / Gas Leak / Cooling Failure
    if (raw.includes('compressor') || raw.includes('refrigerant') || raw.includes('gas') || raw.includes('leak') || raw.includes('cooling') || raw.includes('freon')) {
      return [
        'Electrical Lockout & Connect Manifold Pressure Gauges',
        'Conduct Nitrogen Pressure Test to Pinpoint Refrigerant Piping Leak',
        'Braze/Repair Leaking Pipe Joint, Evacuate System to 500 Microns, and Recharge Refrigerant',
        'Run Compressor Load Test and Verify Operating Pressures and Delta-T Temperature'
      ];
    }

    // 6. Fan / Motor / Capacitor / Noise / Vibration
    if (raw.includes('fan') || raw.includes('motor') || raw.includes('noise') || raw.includes('vibrat') || raw.includes('bearing') || raw.includes('blade')) {
      return [
        'Safety Power Disconnection & Remove Protective Fan Housing',
        'Inspect Motor Bearings, Run Capacitor, and Blower Wheel Alignment',
        'Replace Worn Bearings / Defective Motor Capacitor and Balance Fan Wheel',
        'Power On and Verify Smooth Rotation, Low Vibration, and Proper Air Output'
      ];
    }

    // 7. Electrical / Wiring / Control Board / PCB
    if (raw.includes('wire') || raw.includes('pcb') || raw.includes('board') || raw.includes('relay') || raw.includes('fuse') || raw.includes('circuit')) {
      return [
        'Safety Electrical Isolation & Discharge Capacitors',
        'Inspect Main PCB Control Board, Fuses, and Terminal Wiring for Burn Marks or Damage',
        'Repair/Replace Damaged Wiring Harness or Electronic Control Board',
        'Conduct High-Voltage Test & Validate Electronic Control Functions'
      ];
    }

    // 8. General Defect Default
    const cleanComp = componentName || 'Defective Component';
    return [
      'Safety Isolation & Electrical Power Lockout',
      `Diagnostic Inspection & Defect Root-Cause Confirmation: ${cleanComp}`,
      `Execute Repair, Part Replacement, or Component Overhaul: ${cleanComp}`,
      'System Reassembly, Functional Test, and Telemetry Validation'
    ];
  }

  function getDefaultRepairScope(componentName, defectNotes = '') {
    const raw = (String(componentName || '') + ' ' + String(defectNotes || '')).toLowerCase().trim();
    if (raw.includes('clean') || raw.includes('filter') || raw.includes('wash') || raw.includes('dirt') || raw.includes('drain')) {
      return `Perform comprehensive air conditioning cleaning service for ${componentName}. Remove and deep clean air filters, pressure wash evaporator coils and blower fan, unclog condensate drainage tray and pipe, sanitize internal housing, and test cooling efficiency.`;
    }
    if (raw.includes('temperature') || raw.includes('temp') || raw.includes('thermal') || raw.includes('thermistor')) {
      return `Diagnose and repair temperature monitoring malfunction for ${componentName}. Inspect wiring harness, test control resistance/continuity, replace defective thermal probe if required, and calibrate control telemetry.`;
    }
    if (raw.includes('pressure') || raw.includes('ps-') || raw.includes('baro')) {
      return `Diagnose and service air pressure control system (${componentName}). Clean pneumatic sensing lines, replace damaged pressure transducer, calibrate zero-point offset, and verify live pressure telemetry logs.`;
    }
    if (raw.includes('energy') || raw.includes('power') || raw.includes('current') || raw.includes('voltage')) {
      return `Inspect and repair energy monitoring circuitry for ${componentName}. Test current transformer (CT) clamp, check terminal connections, replace faulty metering control, and verify electrical telemetry readings.`;
    }
    return `Diagnose and execute corrective repair for defect on ${componentName}. Inspect root cause, perform necessary maintenance or part replacement, reassemble unit, and validate operational performance.`;
  }

  function openRepairTaskModal(reportId, targetTaskId = null, targetTaskName = null) {
    let modal = document.getElementById('ecoRepairTaskModal');
    if (!modal) {
      injectRepairTaskModalHTML();
      modal = document.getElementById('ecoRepairTaskModal');
    }
    if (!modal) return;

    const reports = getReports();
    let report = findReportById(reports, reportId) || findReportById(reports, currentDetailId) || reports[0];
    if (!report) return;

    const actualId = report.id || reportId;
    activeRepairReportId = actualId;
    activeRepairReport = report;
    activeRepairTaskId = targetTaskId;
    activeRepairTaskName = targetTaskName;
    isSubmittingRepairTask = false;

    let repairTask = null;
    if (activeRepairTaskId && Array.isArray(report.tasks)) {
      repairTask = report.tasks.find(t => String(t.id) === String(activeRepairTaskId));
    }
    if (!repairTask && activeRepairTaskName && Array.isArray(report.tasks)) {
      const targetName = String(activeRepairTaskName).toLowerCase().trim();
      repairTask = report.tasks.find(t => String(t.name || '').toLowerCase().trim() === targetName);
    }
    if (!repairTask && Array.isArray(report.tasks)) {
      repairTask = report.tasks.find(t => t.status === 'Needs Repair');
    }

    const repairComponentName = repairTask?.name || report.issue?.component || 'Air Pressure Control (PS-802)';
    const repairNotes = repairTask?.notes || report.issue?.notes || '';

    activeRepairPriority = 'Critical';
    activeRepairSteps = getDefaultStepsToFix(repairComponentName, repairNotes);
    editingRepairStepIdx = null;

    renderRepairTaskModalContent(report);

    modal.classList.remove('hidden');
    modal.style.display = 'flex';
    modal.style.zIndex = '100000';
    document.body.style.overflow = 'hidden';

    // Live background query to ensure fresh defect photos & notes from Supabase
    const sb = getSb();
    if (sb && actualId) {
      sb.from('maintenance_reports').select('*').eq('id', actualId).maybeSingle().then(({ data, error }) => {
        if (!error && data) {
          const fresh = normalizeReport(data);
          if (fresh) {
            const idx = _reportsCache.findIndex(r => String(r.id) === String(actualId));
            if (idx !== -1) _reportsCache[idx] = fresh;
            else _reportsCache.unshift(fresh);
            try {
              localStorage.setItem('ecoTrack_maintenance_reports', JSON.stringify(_reportsCache));
            } catch (_) { }

            if (String(activeRepairReportId) === String(actualId)) {
              activeRepairReport = fresh;
              renderRepairTaskModalContent(fresh);
            }
          }
        }
      }).catch(err => console.warn('[openRepairTaskModal live fetch warn]:', err));
    }
  }

  function renderRepairTaskModalContent(report) {
    const header = document.getElementById('ecoRepairTaskModalHeader');
    const body = document.getElementById('ecoRepairTaskModalBody');
    const footer = document.getElementById('ecoRepairTaskModalFooter');
    if (!header || !body || !footer) return;

    const defectiveTasks = Array.isArray(report.tasks) ? report.tasks.filter(t => t.status === 'Needs Repair' || t.status === 'Under Repair' || (!t.repaired && isComponentInIssue(t.name, report.issue))) : [];

    let repairTask = null;
    if (activeRepairTaskId && Array.isArray(report.tasks)) {
      repairTask = report.tasks.find(t => String(t.id) === String(activeRepairTaskId));
    }
    if (!repairTask && activeRepairTaskName && Array.isArray(report.tasks)) {
      const targetName = String(activeRepairTaskName).toLowerCase().trim();
      repairTask = report.tasks.find(t => String(t.name || '').toLowerCase().trim() === targetName);
    }
    if (!repairTask && defectiveTasks.length > 0) {
      repairTask = defectiveTasks[0];
    }
    if (!repairTask && Array.isArray(report.tasks)) {
      repairTask = report.tasks.find(t => t.status === 'Needs Repair');
    }

    if (repairTask) {
      activeRepairTaskId = repairTask.id;
      activeRepairTaskName = repairTask.name;
    }

    const isTaskSwitched = Boolean(repairTask && activeRepairTaskId && String(activeRepairTaskId) !== String(_lastRenderedTaskId));
    _lastRenderedTaskId = repairTask?.id || null;

    const rawIssueComp = typeof report.issue?.component === 'string' ? report.issue.component.split(/[,;/]+/)[0].trim() : '';
    const repairComponentName = repairTask?.name || rawIssueComp || 'Air Pressure Control (PS-802)';

    let repairNotes = repairTask?.notes?.trim() || '';
    if (!repairNotes && typeof report.issue?.notes === 'string') {
      const splitNotes = report.issue.notes.split('•').map(s => s.trim());
      const matched = splitNotes.find(s => {
        const lower = s.toLowerCase();
        return repairComponentName && lower.includes(repairComponentName.toLowerCase());
      });
      if (matched) {
        repairNotes = matched.replace(/^[^:]+:\s*/, '').trim();
      } else {
        repairNotes = splitNotes[0]?.replace(/^[^:]+:\s*/, '').trim() || report.issue.notes;
      }
    }
    if (!repairNotes) {
      repairNotes = 'Component defect detected during inspection requiring repair/replacement.';
    }

    header.innerHTML = `
      <div class="flex-1 pr-3">
        <div class="text-[11px] font-extrabold text-rose-600 dark:text-rose-400 uppercase tracking-wider flex items-center gap-1.5">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
          CORRECTIVE MAINTENANCE DISPATCH
        </div>
        <div class="flex items-center flex-wrap gap-2 mt-0.5">
          <h3 class="text-xl font-bold text-[#18392B] dark:text-white tracking-tight">
            Create Corrective Repair Task
          </h3>
          <span class="px-2.5 py-0.5 text-[10px] font-mono font-bold rounded-full bg-rose-100 dark:bg-rose-500/20 text-rose-800 dark:text-rose-300 border border-rose-400/40 shrink-0">
            Linked to ${report.id}
          </span>
          <span class="px-2.5 py-0.5 text-[10px] font-bold rounded-full bg-emerald-100 dark:bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 border border-emerald-400/40 shrink-0">
            Checklist Task: ${repairComponentName}
          </span>
        </div>
      </div>
      <button type="button" id="btnCloseRepairTaskModal" class="w-8 h-8 rounded-full bg-gray-100 dark:bg-white/10 hover:bg-gray-200 dark:hover:bg-white/20 text-gray-500 dark:text-gray-300 flex items-center justify-center font-bold text-sm cursor-pointer transition-colors shrink-0">
        ✕
      </button>
    `;
    document.getElementById('btnCloseRepairTaskModal')?.addEventListener('click', closeRepairTaskModal);

    const existingTitle = document.getElementById('repairTaskTitleInput')?.value;
    const existingStaff = document.getElementById('repairStaffSelect')?.value;
    const existingDueDate = document.getElementById('repairDueDateInput')?.value;
    const existingScope = document.getElementById('repairScopeInput')?.value;

    const staffList = getStaffList();
    const defaultDueDate = existingDueDate || new Date(Date.now() + 86400000).toISOString().split('T')[0];

    const defaultTitle = `Repair & Calibration: ${repairComponentName}`;
    const taskTitleValue = isTaskSwitched ? defaultTitle : (existingTitle || defaultTitle);
    const defaultScope = getDefaultRepairScope(repairComponentName, repairNotes);
    const taskScopeValue = isTaskSwitched ? defaultScope : (existingScope || defaultScope);

    // Collect defect photos strictly for this repairTask
    const _repairPhotoSet = new Set();
    const _rPush = (p) => {
      if (!p) return;
      if (Array.isArray(p)) {
        p.forEach(item => _rPush(item));
        return;
      }
      if (typeof p === 'string') {
        const trimmed = p.trim();
        if (!trimmed) return;
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
              parsed.forEach(item => _rPush(item));
              return;
            }
          } catch (e) { }
        }
        if (trimmed.includes(',') && !trimmed.startsWith('data:')) {
          trimmed.split(',').forEach(sub => _rPush(sub.trim()));
          return;
        }
        const r = resolvePhotoUrl(trimmed);
        if (r) _repairPhotoSet.add(r);
        return;
      }
      if (typeof p === 'object') {
        const u = p.uri || p.url || p.photoUri || p.photo || p.imageUrl || p.src;
        if (u) _rPush(u);
      }
    };

    // 1. Primary: ONLY this task's photos
    if (repairTask) {
      if (repairTask.photoUris) _rPush(repairTask.photoUris);
      if (repairTask.photos) _rPush(repairTask.photos);
      if (repairTask.images) _rPush(repairTask.images);
      if (repairTask.attachments) _rPush(repairTask.attachments);
      _rPush(repairTask.photo || repairTask.photoUri || repairTask.photo_uri || repairTask.photoUrl || repairTask.photo_url || repairTask.image || repairTask.imageUrl || repairTask.uri);
    }

    // 2. ONLY if no photos in repairTask, fallback to matching by task name in report.tasks
    if (_repairPhotoSet.size === 0 && Array.isArray(report.tasks) && repairComponentName) {
      const compTarget = String(repairComponentName).toLowerCase().trim();
      const matched = report.tasks.find(t => {
        const tName = String(t.name || '').toLowerCase().trim();
        return tName && (tName === compTarget || tName.includes(compTarget) || compTarget.includes(tName));
      });
      if (matched) {
        if (matched.photoUris) _rPush(matched.photoUris);
        if (matched.photos) _rPush(matched.photos);
        if (matched.images) _rPush(matched.images);
        if (matched.attachments) _rPush(matched.attachments);
        _rPush(matched.photo || matched.photoUri || matched.photo_uri || matched.photoUrl || matched.photo_url || matched.image || matched.imageUrl || matched.uri);
      }
    }

    // 3. ONLY if STILL 0 photos, fallback to report.issue ONLY if issue is single-component
    if (_repairPhotoSet.size === 0 && report.issue) {
      const isMulti = (Array.isArray(report.issue.components) && report.issue.components.length > 1) ||
        (typeof report.issue.component === 'string' && report.issue.component.split(/[,;/]+/).filter(Boolean).length > 1);
      if (!isMulti) {
        if (report.issue.photoUris) _rPush(report.issue.photoUris);
        if (report.issue.photos) _rPush(report.issue.photos);
        if (report.issue.images) _rPush(report.issue.images);
        _rPush(report.issue.photoUri || report.issue.photo || report.issue.photo_url || report.issue.photoUrl || report.issue.image);
      }
    }

    // 4. Fallback ONLY if absolutely 0 photos anywhere: check report-level single photo
    if (_repairPhotoSet.size === 0 && report.photo_url) {
      _rPush(report.photo_url);
    }

    const repairPhotos = Array.from(_repairPhotoSet).filter(Boolean);

    const repairCarouselId = 'repairTaskPhotoCarousel';

    // Build inline mini carousel for the repair modal
    const buildRepairPhotoCarousel = (photos) => {
      if (photos.length === 0) return '';
      const cId = repairCarouselId;
      const counterBadge = (i) => photos.length > 1 ? `<span class="absolute top-2 right-2 px-2 py-0.5 text-[10px] font-mono font-bold rounded-full bg-black/60 text-white backdrop-blur-sm border border-white/20">${i + 1}/${photos.length}</span>` : '';
      const slides = photos.map((photo, i) => `
        <div class="carousel-slide shrink-0 w-full" data-slide="${i}">
          <div class="maintenance-photo-preview relative overflow-hidden flex items-center justify-center bg-gray-900 min-h-[200px] cursor-pointer select-none" title="Click to view fullscreen" onclick="window._carouselOpen && window._carouselOpen('${cId}',${i})">
            <img src="${photo}" alt="Defect Photo ${i + 1}" class="w-full max-h-56 object-contain pointer-events-none select-none" onerror="this.onerror=null;this.parentElement.innerHTML='<div class=\\'p-4 text-center text-xs text-rose-400 font-medium\\'>Unable to load image</div>';">
            <div class="maintenance-photo-overlay">
              <span class="px-3.5 py-2 bg-black/85 backdrop-blur-md rounded-xl text-white text-xs font-bold border border-white/20 flex items-center gap-1.5 shadow-lg select-none pointer-events-none">
                <svg class="w-4 h-4 text-rose-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7"/></svg>
                <span>View Fullscreen</span>
              </span>
            </div>
            ${counterBadge(i)}
          </div>
        </div>
      `).join('');

      const nav = photos.length > 1 ? `
        <button class="absolute left-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-black/60 hover:bg-black/80 backdrop-blur-sm border border-white/20 text-white flex items-center justify-center z-10 cursor-pointer shadow-md transition-all" onclick="window._carouselPrev && window._carouselPrev('${cId}')">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M15 19l-7-7 7-7"/></svg>
        </button>
        <button class="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-black/60 hover:bg-black/80 backdrop-blur-sm border border-white/20 text-white flex items-center justify-center z-10 cursor-pointer shadow-md transition-all" onclick="window._carouselNext && window._carouselNext('${cId}')">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7"/></svg>
        </button>
        <div class="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1 z-10">
          ${photos.map((_, i) => `<button data-carousel-id="${cId}" data-idx="${i}" class="carousel-dot w-2 h-2 rounded-full transition-all ${i === 0 ? 'bg-rose-400 w-4' : 'bg-white/40 hover:bg-white/70'}" onclick="window._carouselGoTo && window._carouselGoTo('${cId}',${i})"></button>`).join('')}
        </div>` : '';

      return `
        <div class="carousel-wrapper rounded-2xl overflow-hidden border-2 border-rose-500/40 shadow-lg relative mb-0" id="${cId}">
          <!-- Defect Photo Header -->
          <div class="bg-rose-600 px-3 py-2 flex items-center justify-between">
            <span class="flex items-center gap-1.5 text-white font-bold text-[11px] uppercase tracking-wide">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/><circle cx="12" cy="13" r="3"/></svg>
              Defect Photo Evidence
            </span>
            <div class="flex items-center gap-2">
              ${photos.length > 1 ? `<span class="px-2 py-0.5 text-[9px] font-bold rounded-full bg-white/20 text-white border border-white/30">${photos.length} photos</span>` : ''}
              <button type="button" class="px-2.5 py-0.5 text-[10px] font-bold rounded-lg bg-white/20 hover:bg-white/30 text-white border border-white/30 cursor-pointer flex items-center gap-1 transition-all shadow-xs" onclick="event.stopPropagation(); window._carouselOpen && window._carouselOpen('${cId}', window._carouselState?.['${cId}']?.current || 0)">
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7"/></svg>
                <span>Fullscreen ↗</span>
              </button>
            </div>
          </div>
          <!-- Carousel Track -->
          <div class="relative overflow-hidden bg-gray-950">
            <div class="carousel-track flex transition-transform duration-300 ease-in-out" id="${cId}_track">
              ${slides}
            </div>
            ${nav}
          </div>
        </div>`;
    };

    body.innerHTML = `
      ${repairPhotos.length > 0 ? buildRepairPhotoCarousel(repairPhotos) : ''}

      <!-- Defect Alert Banner -->
      <div class="bg-rose-50/70 dark:bg-rose-950/40 border-2 border-rose-400/50 rounded-2xl p-3.5 shadow-sm">
        <div class="flex items-center justify-between gap-2 mb-1.5">
          <div class="flex items-center gap-2">
            <span class="w-2 h-2 rounded-full bg-rose-600 animate-ping"></span>
            <span class="text-xs font-black text-rose-800 dark:text-rose-300 uppercase tracking-wide">Detected Defect: ${repairComponentName}</span>
          </div>
          <span class="px-2 py-0.5 text-[9px] font-extrabold rounded-full bg-rose-600 text-white uppercase">NEEDS REPAIR</span>
        </div>
        <p class="text-xs text-rose-950 dark:text-rose-200 font-medium italic bg-white/70 dark:bg-slate-900/70 p-2.5 rounded-xl border border-rose-300/60 dark:border-rose-500/30">
          "${repairNotes}"
        </p>
        <div class="flex items-center justify-between text-[11px] text-gray-600 dark:text-gray-400 mt-2 px-1">
          <span>📍 Unit: <strong class="text-gray-800 dark:text-white">${report.airconId}</strong> (${report.room})</span>
          <span>Parent Report: <span class="font-mono font-bold text-gray-700 dark:text-gray-300">${report.id}</span></span>
        </div>
      </div>

      <!-- Task Title -->
      <div class="space-y-1.5">
        <label class="block text-xs font-bold text-gray-800 dark:text-gray-200">
          Repair Order Title <span class="text-rose-500">*</span>:
        </label>
        <input type="text" id="repairTaskTitleInput" value="${taskTitleValue.replace(/"/g, '&quot;')}" class="w-full bg-white dark:bg-[#081326] border border-gray-200 dark:border-white/15 rounded-xl px-3 py-2 text-xs font-bold text-gray-800 dark:text-gray-100 focus:outline-none focus:border-rose-500 shadow-sm">
      </div>

      <!-- Assigned Technician & Priority -->
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label class="block text-[11px] font-bold text-gray-600 dark:text-gray-300 mb-1.5 uppercase">Assign Specialist / Technician</label>
          <select id="repairStaffSelect" class="w-full bg-white dark:bg-[#081326] border border-gray-200 dark:border-white/15 rounded-xl px-3 py-2 text-xs font-semibold text-gray-800 dark:text-gray-100 focus:outline-none focus:border-rose-500 shadow-sm cursor-pointer">
            ${staffList.length > 0 ? staffList.map(s => `
              <option value="${s.id}" ${(s.id === (existingStaff || report.staff_id || report.staffId)) ? 'selected' : ''}>${s.name} (${s.role || 'Technician'})</option>
            `).join('') : `
              <option value="${existingStaff || report.staffName || 'HVAC Technician'}">${existingStaff || report.staffName || 'HVAC Technician'}</option>
            `}
          </select>
        </div>
        <div>
          <label class="block text-[11px] font-bold text-gray-600 dark:text-gray-300 mb-1.5 uppercase">Repair Priority</label>
          <div class="grid grid-cols-3 gap-1.5" id="repairPriorityGrid">
            ${['Medium', 'High', 'Critical'].map(p => `
              <button type="button" class="btn-repair-priority py-2 text-xs rounded-xl font-bold cursor-pointer transition-all text-center ${activeRepairPriority === p ? (p === 'Critical' ? 'bg-rose-600 text-white shadow-sm' : (p === 'High' ? 'bg-amber-500 text-slate-950 shadow-sm' : 'bg-sky-600 text-white shadow-sm')) : 'bg-gray-100 dark:bg-slate-900 border border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300'}" data-priority="${p}">
                ${p}
              </button>
            `).join('')}
          </div>
        </div>
      </div>

      <!-- Target Due Date -->
      <div>
        <label class="block text-[11px] font-bold text-gray-600 dark:text-gray-300 mb-1.5 uppercase">Target Resolution Date</label>
        <input type="date" id="repairDueDateInput" value="${defaultDueDate}" class="w-full bg-white dark:bg-[#081326] border border-gray-200 dark:border-white/15 rounded-xl px-3 py-2 text-xs text-gray-800 dark:text-gray-100 focus:outline-none focus:border-rose-500 shadow-sm">
      </div>

      <!-- Scope of Repair Work -->
      <div class="space-y-1.5">
        <label class="block text-xs font-bold text-gray-800 dark:text-gray-200">
          Scope of Work & Repair Instructions <span class="text-rose-500">*</span>:
        </label>
        <textarea id="repairScopeInput" rows="3" class="w-full bg-white dark:bg-[#081326] border border-gray-200 dark:border-white/15 rounded-2xl p-3 text-xs text-gray-800 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-rose-500 resize-none shadow-sm transition-colors">${taskScopeValue}</textarea>
      </div>

      <!-- Steps to Fix Defect - Interactive Add/Edit/Delete -->
      <div class="space-y-1.5">
        <div class="flex items-center justify-between">
          <div>
            <label class="block text-xs font-bold text-gray-800 dark:text-gray-200">
              Steps to Fix Defect <span class="text-rose-500">*</span>:
            </label>
            <p class="text-[10px] text-gray-500 dark:text-gray-400 font-medium mt-0.5">Required procedure for the technician to repair and fix this defect</p>
          </div>
          <button type="button" id="btnAddRepairStep" class="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-bold rounded-lg bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/40 dark:hover:bg-rose-900/50 text-rose-700 dark:text-rose-300 border border-rose-300/60 dark:border-rose-500/30 cursor-pointer transition-all shadow-xs">
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 4v16m8-8H4"/></svg>
            <span>Add Step</span>
          </button>
        </div>

        <!-- Inline Add Step Input (hidden by default) -->
        <div id="inlineAddStepForm" class="hidden flex items-center gap-2 p-2 bg-white dark:bg-slate-900 border border-rose-400 dark:border-rose-500/50 rounded-xl shadow-xs transition-all">
          <span class="w-5 h-5 rounded-full bg-rose-100 dark:bg-rose-500/20 text-rose-700 dark:text-rose-300 flex items-center justify-center font-bold text-[10px] shrink-0">+</span>
          <input type="text" id="inputNewRepairStep" placeholder="e.g. Deep clean evaporator coil & flush drainage line..." class="flex-1 bg-transparent border-0 text-xs text-gray-800 dark:text-gray-100 focus:outline-none placeholder-gray-400">
          <button type="button" id="btnConfirmAddStep" class="px-3 py-1 bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs rounded-lg cursor-pointer transition-all shadow-xs">Add</button>
          <button type="button" id="btnCancelAddStep" class="px-2 py-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 font-bold text-xs cursor-pointer">✕</button>
        </div>

        <!-- List Container -->
        <div id="repairStepsContainer" class="space-y-1.5 bg-gray-50 dark:bg-slate-950/60 p-2.5 rounded-2xl border border-gray-200 dark:border-white/10 text-xs max-h-56 overflow-y-auto eco-slim-scrollbar">
          <!-- Populated by renderRepairStepsList -->
        </div>
      </div>
    `;

    // Ensure steps are tailored to this defect if empty or old hardcoded generic placeholder
    if (!activeRepairSteps || activeRepairSteps.length === 0 || (activeRepairSteps.length === 4 && activeRepairSteps[0] === 'Safety Isolation & Electrical Power Lockout' && typeof activeRepairSteps[1] === 'string' && activeRepairSteps[1].startsWith('Component Disassembly & Diagnostic Check:'))) {
      activeRepairSteps = getDefaultStepsToFix(repairComponentName, repairNotes);
    }

    // Register repair carousel state so nav buttons, dots, and fullscreen lightbox work
    if (repairPhotos.length > 0) {
      window._carouselState = window._carouselState || {};
      window._carouselState[repairCarouselId] = {
        current: 0,
        photos: repairPhotos,
        title: `Defect Photo Evidence — ${repairComponentName} (${report.id})`,
        dotColor: 'rose'
      };
      window._carouselState[repairCarouselId + '_track'] = window._carouselState[repairCarouselId];
    }

    // Priority selector logic
    body.querySelectorAll('.btn-repair-priority').forEach(btn => {
      btn.addEventListener('click', () => {
        activeRepairPriority = btn.getAttribute('data-priority');
        body.querySelectorAll('.btn-repair-priority').forEach(b => {
          const p = b.getAttribute('data-priority');
          b.className = `btn-repair-priority py-2 text-xs rounded-xl font-bold cursor-pointer transition-all text-center ${activeRepairPriority === p ? (p === 'Critical' ? 'bg-rose-600 text-white shadow-sm' : (p === 'High' ? 'bg-amber-500 text-slate-950 shadow-sm' : 'bg-sky-600 text-white shadow-sm')) : 'bg-gray-100 dark:bg-slate-900 border border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300'}`;
        });
      });
    });

    // Render interactive subtask steps list
    function renderRepairStepsList() {
      const container = body.querySelector('#repairStepsContainer');
      if (!container) return;

      if (activeRepairSteps.length === 0) {
        container.innerHTML = `
          <div class="p-3 text-center text-gray-400 italic">
            No steps to fix remaining. Click "+ Add Step" above to add steps to fix the defect.
          </div>
        `;
        return;
      }

      container.innerHTML = activeRepairSteps.map((stepText, idx) => {
        if (editingRepairStepIdx === idx) {
          return `
            <div class="flex items-center gap-2 p-2 rounded-xl bg-rose-50/90 dark:bg-rose-950/60 border-2 border-rose-400 dark:border-rose-500 transition-all shadow-sm">
              <span class="w-5 h-5 rounded-full bg-rose-600 text-white flex items-center justify-center font-bold text-[10px] shrink-0">${idx + 1}</span>
              <input type="text" class="input-edit-step flex-1 bg-white dark:bg-slate-900 border border-rose-300 dark:border-rose-400/50 rounded-lg px-2.5 py-1 text-xs text-gray-800 dark:text-gray-100 font-medium focus:outline-none focus:ring-1 focus:ring-rose-500" value="${stepText.replace(/"/g, '&quot;')}" autofocus>
              <button type="button" class="btn-save-step px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold shadow-xs cursor-pointer" data-step-idx="${idx}">Save</button>
              <button type="button" class="btn-cancel-edit-step px-2 py-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 text-xs font-bold cursor-pointer" data-step-idx="${idx}">✕</button>
            </div>
          `;
        }

        return `
          <div class="group flex items-center justify-between gap-2 p-2 rounded-xl bg-white dark:bg-slate-900/80 border border-gray-200 dark:border-white/5 hover:border-rose-300 dark:hover:border-rose-500/40 transition-all shadow-xs" data-step-idx="${idx}">
            <div class="flex items-center gap-2.5 flex-1 min-w-0">
              <span class="w-5 h-5 rounded-full bg-rose-100 dark:bg-rose-500/20 text-rose-700 dark:text-rose-300 flex items-center justify-center font-bold text-[10px] shrink-0">${idx + 1}</span>
              <span class="step-text text-gray-700 dark:text-gray-200 font-medium break-words flex-1">${stepText}</span>
            </div>
            <div class="flex items-center gap-1 shrink-0 opacity-80 group-hover:opacity-100 transition-opacity">
              <button type="button" class="btn-edit-step p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-500 hover:text-amber-600 dark:hover:text-amber-400 transition-colors cursor-pointer" data-step-idx="${idx}" title="Edit step">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>
              </button>
              <button type="button" class="btn-delete-step p-1.5 rounded-lg hover:bg-rose-50 dark:hover:bg-rose-950/50 text-gray-500 hover:text-rose-600 dark:hover:text-rose-400 transition-colors cursor-pointer" data-step-idx="${idx}" title="Delete step">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
              </button>
            </div>
          </div>
        `;
      }).join('');

      // Wire Edit buttons
      container.querySelectorAll('.btn-edit-step').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          editingRepairStepIdx = parseInt(btn.getAttribute('data-step-idx'));
          renderRepairStepsList();
        });
      });

      // Wire Save buttons
      container.querySelectorAll('.btn-save-step').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = parseInt(btn.getAttribute('data-step-idx'));
          const input = container.querySelector('.input-edit-step');
          const val = input ? input.value.trim() : '';
          if (val) {
            activeRepairSteps[idx] = val;
            editingRepairStepIdx = null;
            renderRepairStepsList();
          } else {
            showToast('Required', 'Step description cannot be empty.', 'error');
          }
        });
      });

      // Wire Cancel Edit buttons
      container.querySelectorAll('.btn-cancel-edit-step').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          editingRepairStepIdx = null;
          renderRepairStepsList();
        });
      });

      // Wire Delete buttons
      container.querySelectorAll('.btn-delete-step').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = parseInt(btn.getAttribute('data-step-idx'));
          if (activeRepairSteps.length <= 1) {
            showToast('Cannot Delete', 'At least one step to fix the defect is required.', 'error');
            return;
          }
          activeRepairSteps.splice(idx, 1);
          if (editingRepairStepIdx === idx) editingRepairStepIdx = null;
          else if (editingRepairStepIdx > idx) editingRepairStepIdx--;
          renderRepairStepsList();
        });
      });

      // Key listener for inline edit input
      const editInput = container.querySelector('.input-edit-step');
      if (editInput) {
        editInput.focus();
        editInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            container.querySelector('.btn-save-step')?.click();
          } else if (e.key === 'Escape') {
            editingRepairStepIdx = null;
            renderRepairStepsList();
          }
        });
      }
    }

    // Wire Add Step controls
    const btnAddStep = body.querySelector('#btnAddRepairStep');
    const inlineAddForm = body.querySelector('#inlineAddStepForm');
    const inputNewStep = body.querySelector('#inputNewRepairStep');
    const btnConfirmAdd = body.querySelector('#btnConfirmAddStep');
    const btnCancelAdd = body.querySelector('#btnCancelAddStep');

    btnAddStep?.addEventListener('click', () => {
      inlineAddForm?.classList.remove('hidden');
      inputNewStep?.focus();
    });

    btnCancelAdd?.addEventListener('click', () => {
      if (inputNewStep) inputNewStep.value = '';
      inlineAddForm?.classList.add('hidden');
    });

    function commitAddStep() {
      const val = inputNewStep?.value.trim();
      if (!val) {
        showToast('Required', 'Please enter a step description.', 'error');
        return;
      }
      activeRepairSteps.push(val);
      if (inputNewStep) inputNewStep.value = '';
      inlineAddForm?.classList.add('hidden');
      renderRepairStepsList();
    }

    btnConfirmAdd?.addEventListener('click', commitAddStep);
    inputNewStep?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitAddStep();
      } else if (e.key === 'Escape') {
        if (inputNewStep) inputNewStep.value = '';
        inlineAddForm?.classList.add('hidden');
      }
    });

    // Initial render of steps
    renderRepairStepsList();

    // Footer actions (Single handler, no duplicate onclick)
    footer.innerHTML = `
      <button type="button" id="btnCancelRepairTask" class="px-5 py-2.5 bg-gray-100 dark:bg-slate-800 hover:bg-gray-200 dark:hover:bg-slate-700 text-gray-700 dark:text-gray-300 font-bold text-xs rounded-2xl cursor-pointer transition-colors shrink-0">
        Cancel
      </button>
      <button type="button" id="btnSubmitRepairTask" class="px-6 py-2.5 bg-rose-600 hover:bg-rose-500 active:scale-95 text-white font-bold text-xs rounded-2xl cursor-pointer transition-all shadow-md flex items-center gap-1.5 shrink-0 relative z-30 select-none">
        <svg class="w-4 h-4 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
        <span class="pointer-events-none">Dispatch Repair Task</span>
      </button>
    `;

    document.getElementById('btnCancelRepairTask')?.addEventListener('click', closeRepairTaskModal);
    document.getElementById('btnSubmitRepairTask')?.addEventListener('click', submitRepairTask);
  }

  async function submitRepairTask(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    if (e && typeof e.stopPropagation === 'function') e.stopPropagation();

    if (isSubmittingRepairTask) {
      console.warn('[submitRepairTask] Dispatch already in progress...');
      return;
    }
    isSubmittingRepairTask = true;

    const btnSubmit = document.getElementById('btnSubmitRepairTask');
    const resetRepairBtn = () => {
      isSubmittingRepairTask = false;
      if (btnSubmit) {
        btnSubmit.disabled = false;
        btnSubmit.style.pointerEvents = 'auto';
        btnSubmit.classList.remove('opacity-75', 'cursor-not-allowed');
        btnSubmit.innerHTML = `
          <svg class="w-4 h-4 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
          <span class="pointer-events-none">Dispatch Repair Task</span>
        `;
      }
    };

    if (btnSubmit) {
      btnSubmit.disabled = true;
      btnSubmit.style.pointerEvents = 'none';
      btnSubmit.classList.add('opacity-75', 'cursor-not-allowed');
      btnSubmit.innerHTML = `
        <svg class="w-4 h-4 animate-spin pointer-events-none" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
        </svg>
        <span class="pointer-events-none">Dispatching Repair Task...</span>
      `;
    }

    const report = activeRepairReport || findReportById(getReports(), activeRepairReportId) || findReportById(getReports(), currentDetailId);
    if (!report) {
      resetRepairBtn();
      showToast('Error', 'Parent maintenance report not found.', 'error');
      return;
    }

    const repairTask = report.tasks ? (
      (activeRepairTaskId ? report.tasks.find(t => String(t.id) === String(activeRepairTaskId)) : null) ||
      (activeRepairTaskName ? report.tasks.find(t => String(t.name || '').toLowerCase().trim() === String(activeRepairTaskName).toLowerCase().trim()) : null) ||
      (report.issue && report.issue.taskId ? report.tasks.find(t => String(t.id) === String(report.issue.taskId)) : null) ||
      (report.issue && report.issue.component ? report.tasks.find(t => isComponentInIssue(t.name, report.issue)) : null) ||
      report.tasks.find(t => t.status === 'Needs Repair' || t.status === 'Under Repair')
    ) : null;
    const repairComponentName = repairTask?.name || report.issue?.component || 'Air Pressure Control (PS-802)';
    const repairNotes = repairTask?.notes || report.issue?.notes || 'Component defect detected during inspection requiring repair/replacement.';

    const titleInput = document.getElementById('repairTaskTitleInput');
    const title = titleInput ? titleInput.value.trim() : '';
    const staffSelect = document.getElementById('repairStaffSelect');
    const staffId = resolveValidStaffId(staffSelect?.value || report.staff_id || report.staffId, report.staffName);
    const staffName = getStaffList().find(s => s.id === staffId)?.name || report.staffName || 'HVAC Technician';
    const dueDateInput = document.getElementById('repairDueDateInput');
    const defaultDueDate = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    const dueDate = (dueDateInput && dueDateInput.value) ? dueDateInput.value : defaultDueDate;
    const scopeInput = document.getElementById('repairScopeInput');
    const scope = scopeInput ? scopeInput.value.trim() : '';

    if (!title) {
      resetRepairBtn();
      showToast('Required Field', 'Please provide a repair title.', 'error');
      titleInput?.focus();
      return;
    }

    if (!scope) {
      resetRepairBtn();
      showToast('Required Field', 'Please provide the scope of repair work.', 'error');
      scopeInput?.focus();
      return;
    }

    if (!activeRepairSteps || activeRepairSteps.length === 0) {
      resetRepairBtn();
      showToast('Steps Required', 'Please provide at least one step to fix the defect.', 'error');
      return;
    }

    try {
      const newReportId = `REP-${Math.floor(1000 + Math.random() * 9000)}`;
      const defectPhotoUris = (repairTask && Array.isArray(repairTask.photoUris) && repairTask.photoUris.length > 0) ? [...repairTask.photoUris] :
        (repairTask && (repairTask.photo || repairTask.photoUri)) ? [repairTask.photo || repairTask.photoUri] :
        [];
      const defectPhoto = defectPhotoUris[0] ||
        (report.issue && (report.issue.photoUri || report.issue.photo || report.issue.photo_url)) ||
        report.photo_url ||
        (Array.isArray(report.photos) && report.photos[0]) || null;

      const newRepairReport = {
        id: newReportId,
        airconId: report.airconId,
        aircon_id: report.aircon_id,
        aircon_name: report.aircon_name || report.airconId,
        airconType: report.airconType,
        aircon_type: report.aircon_type,
        room: report.room,
        room_name: report.room_name,
        type: 'Corrective Repair',
        priority: activeRepairPriority || 'Critical',
        staffName: staffName,
        staff_name: staffName,
        staff_id: staffId,
        staffId: staffId,
        dueDate: dueDate,
        due_date: dueDate,
        createdDate: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        created_date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        status: 'In Progress',
        description: `${title} — ${scope}`,
        issue: {
          component: repairComponentName,
          notes: repairNotes,
          photo: defectPhoto,
          photoUri: defectPhoto,
          photos: defectPhotoUris,
          photoUris: defectPhotoUris,
          parentReportId: report.id,
          parentTaskId: repairTask ? repairTask.id : null,
          parentTaskName: repairTask ? repairTask.name : (repairComponentName || '')
        },
        photo_url: defectPhoto,
        tasks: activeRepairSteps.map((stepText, i) => {
          return {
            id: i + 1,
            name: stepText,
            status: 'Not Started',
            notes: '',
            photo: null,
            photoUri: null,
            photos: [],
            photoUris: [],
            verified: false,
            updated: 'Pending'
          };
        }),
        verificationRemarks: '',
        timeline: [
          { title: `Corrective repair task dispatched from Report ${report.id}`, time: 'Just now', done: true, by: 'Supervisor' },
          { title: `Assigned to ${staffName}`, time: 'Just now', done: true, by: 'Supervisor' }
        ],
        parentReportId: report.id,
        parent_report_id: report.id,
        parentTaskId: repairTask ? repairTask.id : null,
        parent_task_id: repairTask ? repairTask.id : null,
        parentTaskName: repairTask ? repairTask.name : (repairComponentName || ''),
        parent_task_name: repairTask ? repairTask.name : (repairComponentName || ''),
        created: new Date().toISOString()
      };

      if (!Array.isArray(report.linkedRepairIds)) report.linkedRepairIds = [];
      if (!report.linkedRepairIds.includes(newReportId)) report.linkedRepairIds.push(newReportId);
      report.linkedRepairId = newReportId;
      if (!report.timeline) report.timeline = [];
      report.timeline.unshift({
        title: `Corrective Repair Task ${newReportId} dispatched to ${staffName} for ${repairComponentName}`,
        time: 'Just now',
        done: true,
        by: 'Supervisor'
      });

      // Transition the defective task and issue explicitly to 'Under Repair'
      if (repairTask) {
        repairTask.status = 'Under Repair';
        repairTask.linkedRepairId = newReportId;
        repairTask.updated = 'Just now';
      } else if (Array.isArray(report.tasks)) {
        report.tasks.forEach(t => {
          if (repairComponentName && isComponentInIssue(t.name, { component: repairComponentName })) {
            t.status = 'Under Repair';
            t.linkedRepairId = newReportId;
            t.updated = 'Just now';
          }
        });
      }
      const hasOtherNeedsRepair = Array.isArray(report.tasks) && report.tasks.some(t => {
        const isThisTask = repairTask ? (t.id === repairTask.id) : (repairComponentName && isComponentInIssue(t.name, { component: repairComponentName }));
        return !isThisTask && t.status === 'Needs Repair' && !t.repaired;
      });
      if (report.issue) {
        report.issue.status = hasOtherNeedsRepair ? 'Needs Repair' : 'Under Repair';
        report.issue.linkedRepairId = newReportId;
      }
      report.status = hasOtherNeedsRepair ? 'Needs Repair' : 'Under Repair';

      const reports = getReports();
      const existingIdx = reports.findIndex(r => String(r.id).toUpperCase() === String(newReportId).toUpperCase());
      if (existingIdx !== -1) {
        reports[existingIdx] = newRepairReport;
      } else {
        reports.unshift(newRepairReport);
      }

      // Fast local save & optimistic UI update
      _reportsCache = syncReportsWithLinkedRepairs(deduplicateReports(reports.map(normalizeReport).filter(Boolean)));
      try {
        localStorage.setItem('ecoTrack_maintenance_reports', JSON.stringify(_reportsCache));
        window.dispatchEvent(new Event('storage'));
        if (typeof window.resetPageReportFilters === 'function') {
          window.resetPageReportFilters(true);
        } else {
          refreshPageReportsView();
        }
        window.dispatchEvent(new CustomEvent('ecotrack:reports-updated', { detail: _reportsCache }));
        broadcastMaintenanceChange('REPAIR_DISPATCHED');
      } catch (e) {
        console.error('Error saving maintenance reports locally:', e);
      }

      // Close modal and refresh parent detail immediately
      closeRepairTaskModal();
      renderDetailModalContent();
      showToast('Repair Task Dispatched', `Corrective repair order ${newReportId} successfully dispatched to ${staffName}!`, 'success');

      // Sync both to Supabase safely in the background
      (async () => {
        try {
          await saveReports(reports, newRepairReport, true);
          await saveReports(reports, report, false);
          console.log(`[EcoTrack Repair Dispatch] Synced ${newReportId} and parent ${report.id} to Supabase.`);
        } catch (err) {
          console.warn('[EcoTrack Repair Dispatch] Background sync warning:', err);
        }
      })();

    } catch (err) {
      console.error('[submitRepairTask] Unexpected error:', err);
      showToast('Error', 'Failed to dispatch repair task: ' + (err.message || 'Unknown error'), 'error');
      if (btnSubmit) {
        btnSubmit.disabled = false;
        btnSubmit.classList.remove('opacity-75', 'cursor-not-allowed');
        btnSubmit.innerHTML = `
          <svg class="w-4 h-4 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
          <span class="pointer-events-none">Dispatch Repair Task</span>
        `;
      }
    } finally {
      isSubmittingRepairTask = false;
    }
  }

  // ===================================================================
  // 3.8. DEDICATED CORRECTIVE REPAIR ORDER (REP) EDIT & VIEW CONTROLLER
  // ===================================================================

  let activeEditRepairId = null;
  let activeEditRepairReport = null;
  let activeEditRepairSteps = [];

  function injectEditRepairTaskModalHTML() {
    if (document.getElementById('ecoEditRepairTaskModal')) return;
    const modalHTML = `
      <div id="ecoEditRepairTaskModal" class="hidden fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-[9999] flex items-center justify-center p-3 sm:p-5 transition-all">
        <div class="bg-white dark:bg-[#0c1328] border-2 border-rose-500/50 dark:border-rose-500/50 rounded-3xl w-full max-w-2xl shadow-2xl flex flex-col overflow-hidden text-gray-800 dark:text-gray-100 max-h-[92vh]">
          <div id="ecoEditRepairTaskModalHeader" class="px-6 py-4 bg-gradient-to-r from-rose-50 to-gray-50 dark:from-[#2a0e16] dark:to-[#0c1328] border-b border-rose-500/30 flex items-center justify-between shrink-0">
            <!-- Injected by renderEditRepairTaskModalContent -->
          </div>
          <div id="ecoEditRepairTaskModalBody" class="p-6 overflow-y-auto space-y-4 flex-1 eco-slim-scrollbar bg-gray-50/50 dark:bg-[#080e1d]/80">
            <!-- Injected by renderEditRepairTaskModalContent -->
          </div>
          <div id="ecoEditRepairTaskModalFooter" class="px-6 py-3.5 bg-gray-50 dark:bg-slate-950/90 border-t border-gray-200 dark:border-white/10 flex items-center justify-end gap-3 shrink-0">
            <!-- Injected by renderEditRepairTaskModalContent -->
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHTML);

    const modal = document.getElementById('ecoEditRepairTaskModal');
    modal?.addEventListener('click', (e) => {
      if (e.target === modal) closeEditRepairTaskModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) {
        closeEditRepairTaskModal();
      }
    });
  }

  function openEditRepairTaskModal(reportId) {
    if (!reportId) return;
    const reports = getReports();
    const report = findReportById(reports, reportId);
    if (!report) {
      showToast('Error', `Repair order ${reportId} not found.`, 'error');
      return;
    }

    activeEditRepairId = report.id;
    activeEditRepairReport = report;
    activeEditRepairSteps = Array.isArray(report.tasks) && report.tasks.length > 0
      ? report.tasks.map(t => ({ ...t, id: t.id, name: t.name || '', status: t.status || 'Not Started', notes: t.notes || '' }))
      : [
        { id: 1, name: 'Safety Isolation & Electrical Circuit Lockout', status: 'Not Started' },
        { id: 2, name: 'Diagnose Defect & Test Continuity with Multimeter', status: 'Not Started' },
        { id: 3, name: 'Replace Defective Component & Secure Mountings', status: 'Not Started' },
        { id: 4, name: 'Calibrate Control and Verify Telemetry in Dashboard', status: 'Not Started' }
      ];

    injectEditRepairTaskModalHTML();
    renderEditRepairTaskModalContent(report);

    const modal = document.getElementById('ecoEditRepairTaskModal');
    if (modal) {
      modal.classList.remove('hidden');
      modal.style.display = 'flex';
      document.body.style.overflow = 'hidden';
    }
  }

  function closeEditRepairTaskModal() {
    const modal = document.getElementById('ecoEditRepairTaskModal');
    if (modal) {
      modal.classList.add('hidden');
      modal.style.display = 'none';
      document.body.style.overflow = '';
    }
    activeEditRepairId = null;
    activeEditRepairReport = null;
    activeEditRepairSteps = [];
  }

  function renderEditRepairTaskModalContent(report) {
    const header = document.getElementById('ecoEditRepairTaskModalHeader');
    const body = document.getElementById('ecoEditRepairTaskModalBody');
    const footer = document.getElementById('ecoEditRepairTaskModalFooter');
    if (!header || !body || !footer) return;

    const staffList = getStaffList();
    const activeStaff = staffList.filter(s => s && !s.isArchived && s.status !== 'Archived' && !s.is_archived);
    if (!activeStaff.some(s => s.name === report.staffName) && report.staffName && report.staffName !== 'Unassigned') {
      activeStaff.unshift({ id: report.staff_id || report.staffId, name: report.staffName, role: 'Technician' });
    }

    const parentId = report.parentReportId || report.parent_report_id || null;
    const flaggedComp = report.issue?.component || (Array.isArray(report.tasks) && report.tasks[0]?.name) || 'Defective Control / Component';
    const rawEditDefectPhotos = (Array.isArray(report.photos) && report.photos.length > 0)
      ? report.photos
      : ((Array.isArray(report.issue?.photos) && report.issue.photos.length > 0)
        ? report.issue.photos
        : ((Array.isArray(report.issue?.photoUris) && report.issue.photoUris.length > 0)
          ? report.issue.photoUris
          : (report.photo_url ? [report.photo_url] : (report.issue?.photo ? [report.issue.photo] : []))));
    const editDefectPhotos = rawEditDefectPhotos.map(resolvePhotoUrl).filter(Boolean);

    header.innerHTML = `
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-xl bg-rose-50 dark:bg-rose-500/20 border border-rose-500/40 text-rose-600 dark:text-rose-400 flex items-center justify-center shadow-sm shrink-0">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.3">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>
          </svg>
        </div>
        <div>
          <div class="flex items-center gap-2">
            <h2 class="text-base font-bold text-gray-900 dark:text-white">Edit Corrective Repair Order</h2>
            <span class="px-2 py-0.5 text-xs font-mono font-black rounded-md bg-rose-100 dark:bg-rose-500/20 text-rose-700 dark:text-rose-300 border border-rose-400/40">${report.id}</span>
          </div>
          <p class="text-xs text-gray-500 dark:text-gray-400 font-medium">Modifying defect remediation order & remediation checklist</p>
        </div>
      </div>
      <button type="button" onclick="window.EcoTrackMaintenance.closeEditRepairTaskModal()" class="w-8 h-8 rounded-full bg-gray-100 dark:bg-white/10 hover:bg-gray-200 dark:hover:bg-white/20 text-gray-500 dark:text-gray-300 flex items-center justify-center font-bold text-sm cursor-pointer transition-colors">✕</button>
    `;

    body.innerHTML = `
      <!-- Fixed Unit Context Banner (NO dropdown, eliminates duplicate report warning) -->
      <div class="p-3.5 bg-white dark:bg-[#0c162d] border border-rose-500/30 rounded-2xl flex items-center justify-between gap-3 shadow-xs">
        <div class="flex items-center gap-2.5 min-w-0">
          <div class="w-8 h-8 rounded-lg bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-rose-400 shrink-0">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="2" y="3" width="20" height="14" rx="2"></rect>
              <line x1="8" y1="21" x2="16" y2="21"></line>
              <line x1="12" y1="17" x2="12" y2="21"></line>
            </svg>
          </div>
          <div class="truncate">
            <span class="text-[10px] font-bold text-rose-600 dark:text-rose-400 uppercase tracking-wider block">Target Aircon & Control Unit</span>
            <span class="text-xs font-bold text-gray-800 dark:text-white truncate block">${maintenanceDeviceLabel()}: ${maintenanceDisplayText(maintenanceReportEquipment(report).controllerName)} • ${maintenanceDisplayText(maintenanceReportEquipment(report).location)}</span>
          </div>
        </div>
        ${parentId ? `
          <span class="px-2.5 py-1 text-[11px] font-mono font-bold rounded-lg bg-rose-500/10 text-rose-400 border border-rose-500/30 shrink-0">
            Linked: ${parentId}
          </span>
        ` : ''}
      </div>

      <!-- Flagged Component & Symptoms -->
      <div class="space-y-3">
        <div>
          <label class="block text-[11px] font-bold text-gray-700 dark:text-gray-300 uppercase tracking-wider mb-1">Flagged Defective Component</label>
          <input type="text" id="editRepComponentInput" value="${flaggedComp}" class="w-full bg-white dark:bg-[#0c1328] border border-gray-200 dark:border-rose-500/40 rounded-xl px-3.5 py-2 text-xs font-bold text-gray-800 dark:text-white focus:outline-none focus:border-rose-500 transition-colors shadow-xs" placeholder="e.g. Temperature Control Inspection">
        </div>

        <div>
          <label class="block text-[11px] font-bold text-gray-700 dark:text-gray-300 uppercase tracking-wider mb-1">Defect Diagnostic Findings & Symptoms</label>
          <textarea id="editRepDescriptionInput" rows="3" class="w-full bg-white dark:bg-[#0c1328] border border-gray-200 dark:border-rose-500/40 rounded-xl p-3 text-xs text-gray-800 dark:text-white focus:outline-none focus:border-rose-500 transition-colors shadow-xs" placeholder="Describe the defect symptoms, root cause, or diagnostic measurements...">${report.description || report.issue?.notes || ''}</textarea>
        </div>

        ${editDefectPhotos.length > 0 ? `
          <div class="p-3 bg-white dark:bg-[#0c162d] border border-rose-500/30 rounded-2xl space-y-2 shadow-xs">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <span class="text-[10px] uppercase font-bold text-gray-700 dark:text-gray-300">Attached Defect Proof Evidence</span>
                <span class="px-2 py-0.5 text-[10px] font-mono font-bold rounded-full bg-rose-500/15 text-rose-600 dark:text-rose-300 border border-rose-500/30">
                  ${editDefectPhotos.length} ${editDefectPhotos.length === 1 ? 'Photo' : 'Photos'}
                </span>
              </div>
              <div class="flex items-center gap-1.5">
                ${editDefectPhotos.length > 4 ? `
                  <button type="button" id="btnToggleEditDefectPhotosView" class="px-2 py-0.5 text-[10px] font-bold rounded-md bg-white dark:bg-slate-900 hover:bg-rose-50 dark:hover:bg-rose-950/40 text-rose-600 dark:text-rose-300 border border-rose-400/40 transition-all flex items-center gap-1 cursor-pointer shadow-2xs" title="Toggle between compact row and full grid">
                    <span id="txtToggleEditDefectPhotos">${window._editDefectEvidenceExpanded ? 'Minimize ▴' : 'Expand All ▾'}</span>
                  </button>
                ` : ''}
                <button type="button" id="btnOpenEditDefectGallery" class="px-2 py-0.5 text-[10px] font-bold rounded-md bg-rose-600 hover:bg-rose-500 text-white transition-all flex items-center gap-1 cursor-pointer shadow-xs" title="Open Fullscreen Gallery">
                  <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7"/></svg>
                  <span>Gallery</span>
                </button>
              </div>
            </div>

            <!-- Minimized Strip View (Default when > 4 photos) -->
            <div id="editDefectPhotosCompactContainer" class="${(editDefectPhotos.length > 4 && !window._editDefectEvidenceExpanded) ? 'flex' : 'hidden'} items-center gap-2 overflow-x-auto eco-slim-scrollbar py-1 pb-1.5">
              ${editDefectPhotos.slice(0, 8).map((url, i) => `
                <div class="edit-defect-thumbnail w-14 h-14 sm:w-16 sm:h-16 rounded-xl overflow-hidden border-2 border-rose-400/50 shadow-xs cursor-pointer hover:scale-105 hover:border-rose-500 transition-all relative group bg-black/20 shrink-0" data-idx="${i}" title="View proof evidence ${i + 1} of ${editDefectPhotos.length}">
                  <img src="${url}" class="w-full h-full object-cover" alt="Defect Photo ${i + 1}" loading="lazy" onerror="window.handlePhotoLoadError ? window.handlePhotoLoadError(this, ${i + 1}) : (this.onerror=null, this.parentElement.innerHTML='<div class=\\'w-full h-full flex items-center justify-center text-[9px] text-rose-400\\'>Photo</div>');">
                  <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white text-xs font-bold gap-1">
                    <span>🔍</span>
                  </div>
                  <span class="absolute bottom-1 right-1 px-1 py-0.2 text-[8px] font-mono font-bold rounded bg-black/70 text-white backdrop-blur-xs">${i + 1}</span>
                </div>
              `).join('')}
              ${editDefectPhotos.length > 8 ? `
                <div id="btnEditDefectPhotosMorePill" class="w-14 h-14 sm:w-16 sm:h-16 rounded-xl border-2 border-dashed border-rose-400/60 hover:border-rose-500 bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 dark:text-rose-300 flex flex-col items-center justify-center cursor-pointer transition-all shrink-0 p-1 text-center shadow-xs" title="View all ${editDefectPhotos.length} photos">
                  <span class="text-xs font-black">+${editDefectPhotos.length - 8}</span>
                  <span class="text-[8px] font-bold">More</span>
                </div>
              ` : ''}
            </div>

            <!-- Expanded Grid View -->
            <div id="editDefectPhotosGridContainer" class="${(editDefectPhotos.length <= 4 || window._editDefectEvidenceExpanded) ? 'grid' : 'hidden'} grid-cols-4 sm:grid-cols-6 gap-2">
              ${editDefectPhotos.map((url, i) => `
                <div class="edit-defect-thumbnail w-full aspect-square rounded-xl overflow-hidden border-2 border-rose-400/50 shadow-xs cursor-pointer hover:scale-105 hover:border-rose-500 transition-all relative group bg-black/20" data-idx="${i}" title="View proof evidence ${i + 1} of ${editDefectPhotos.length}">
                  <img src="${url}" class="w-full h-full object-cover" alt="Defect Photo ${i + 1}" loading="lazy" onerror="window.handlePhotoLoadError ? window.handlePhotoLoadError(this, ${i + 1}) : (this.onerror=null, this.parentElement.innerHTML='<div class=\\'w-full h-full flex items-center justify-center text-[9px] text-rose-400\\'>Photo</div>');">
                  <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white text-xs font-bold gap-1">
                    <span>🔍</span>
                  </div>
                  <span class="absolute bottom-1 right-1 px-1 py-0.2 text-[8px] font-mono font-bold rounded bg-black/70 text-white backdrop-blur-xs">${i + 1}</span>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}
      </div>

      <!-- Sequential Remediation Steps Builder -->
      <div class="space-y-2 pt-1">
        <div class="flex items-center justify-between">
          <label class="text-[11px] font-bold text-rose-600 dark:text-rose-400 uppercase tracking-wider flex items-center gap-1.5">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>
            Sequential Remediation Steps Checklist
          </label>
          <button type="button" id="btnAddEditRepStep" class="px-2.5 py-1 text-[11px] font-bold rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-rose-600 dark:text-rose-300 border border-rose-500/40 flex items-center gap-1 cursor-pointer transition-all shadow-xs">
            + Add Repair Step
          </button>
        </div>

        <!-- Inline Add Step Form (Type Form) -->
        <div id="inlineAddEditRepStepForm" class="hidden items-center gap-2 p-2 bg-white dark:bg-[#0a0f1d] border-2 border-dashed border-rose-400/60 dark:border-rose-500/50 rounded-xl shadow-xs transition-all">
          <span class="checklist-step-badge badge-rose w-6 h-6 rounded-md bg-rose-600 text-white font-black text-xs flex items-center justify-center shrink-0 shadow-xs">+</span>
          <input type="text" id="inputNewEditRepStep" placeholder="Type new remediation step (e.g. Replace faulty control, test pressure)..." class="flex-1 bg-transparent border-none text-xs font-bold text-gray-800 dark:text-gray-100 focus:outline-none placeholder-gray-400">
          <button type="button" id="btnConfirmAddEditRepStep" class="px-3.5 py-1.5 bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs rounded-lg cursor-pointer transition-all shadow-xs flex items-center gap-1 shrink-0">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
            Add Step
          </button>
          <button type="button" id="btnCancelAddEditRepStep" class="px-2.5 py-1.5 text-gray-400 hover:text-rose-500 font-bold text-xs rounded-lg hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors cursor-pointer shrink-0" title="Cancel">
            ✕
          </button>
        </div>

        <div id="editRepStepsList" class="space-y-2">
          <!-- Populated dynamically -->
        </div>
      </div>

      <!-- Technician, Priority, and Due Date -->
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
        <div>
          <label class="block text-[11px] font-bold text-gray-700 dark:text-gray-300 uppercase tracking-wider mb-1">Assigned Specialist</label>
          <select id="editRepStaffSelect" class="w-full bg-white dark:bg-[#0c1328] border border-gray-200 dark:border-rose-500/40 rounded-xl px-3 py-2 text-xs font-bold text-gray-800 dark:text-gray-200 focus:outline-none focus:border-rose-500 cursor-pointer shadow-xs">
            ${activeStaff.map(s => `<option value="${s.id}" ${s.id === (report.staff_id || report.staffId) ? 'selected' : ''}>${s.name}</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="block text-[11px] font-bold text-gray-700 dark:text-gray-300 uppercase tracking-wider mb-1">Priority</label>
          <select id="editRepPrioritySelect" class="w-full bg-white dark:bg-[#0c1328] border border-gray-200 dark:border-rose-500/40 rounded-xl px-3 py-2 text-xs font-bold text-gray-800 dark:text-gray-200 focus:outline-none focus:border-rose-500 cursor-pointer shadow-xs">
            <option value="Critical" ${report.priority === 'Critical' ? 'selected' : ''}>🔴 Critical</option>
            <option value="High" ${report.priority === 'High' ? 'selected' : ''}>🟠 High</option>
            <option value="Medium" ${report.priority === 'Medium' ? 'selected' : ''}>🟡 Medium</option>
            <option value="Low" ${report.priority === 'Low' ? 'selected' : ''}>🟢 Low</option>
          </select>
        </div>
        <div>
          <label class="block text-[11px] font-bold text-gray-700 dark:text-gray-300 uppercase tracking-wider mb-1">Target Due Date</label>
          <input type="date" id="editRepDueDateInput" value="${report.dueDate || ''}" class="w-full bg-white dark:bg-[#0c1328] border border-gray-200 dark:border-rose-500/40 rounded-xl px-3 py-2 text-xs font-bold text-gray-800 dark:text-gray-200 focus:outline-none focus:border-rose-500 shadow-xs">
        </div>
      </div>
    `;

    footer.innerHTML = `
      <button type="button" onclick="window.EcoTrackMaintenance.closeEditRepairTaskModal()" class="px-4 py-2 rounded-xl bg-gray-100 dark:bg-slate-800 hover:bg-gray-200 dark:hover:bg-slate-700 text-gray-700 dark:text-gray-300 text-xs font-bold cursor-pointer transition-colors">
        Cancel
      </button>
      <button type="button" id="btnSaveEditRepModal" class="px-5 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs shadow-md shadow-rose-600/30 border border-rose-400 cursor-pointer transition-all flex items-center gap-1.5">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
        Save Repair Order
      </button>
    `;

    renderEditRepStepsList();

    body.querySelectorAll('.edit-defect-thumbnail').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.getAttribute('data-idx') || '0', 10);
        openImageLightbox(editDefectPhotos, `Defect Evidence Photo ${idx + 1} of ${editDefectPhotos.length}`, idx);
      });
    });

    const btnToggleEdit = body.querySelector('#btnToggleEditDefectPhotosView');
    if (btnToggleEdit) {
      btnToggleEdit.addEventListener('click', () => {
        window._editDefectEvidenceExpanded = !window._editDefectEvidenceExpanded;
        const compact = body.querySelector('#editDefectPhotosCompactContainer');
        const grid = body.querySelector('#editDefectPhotosGridContainer');
        const txt = body.querySelector('#txtToggleEditDefectPhotos');
        if (window._editDefectEvidenceExpanded) {
          compact?.classList.add('hidden');
          compact?.classList.remove('flex');
          grid?.classList.remove('hidden');
          grid?.classList.add('grid');
          if (txt) txt.textContent = 'Minimize ▴';
        } else {
          compact?.classList.remove('hidden');
          compact?.classList.add('flex');
          grid?.classList.add('hidden');
          grid?.classList.remove('grid');
          if (txt) txt.textContent = `Expand All (${editDefectPhotos.length}) ▾`;
        }
      });
    }

    body.querySelector('#btnEditDefectPhotosMorePill')?.addEventListener('click', () => {
      openImageLightbox(editDefectPhotos, `Defect Evidence Photo 9 of ${editDefectPhotos.length}`, 8);
    });

    body.querySelector('#btnOpenEditDefectGallery')?.addEventListener('click', () => {
      openImageLightbox(editDefectPhotos, `Defect Evidence Gallery (1 of ${editDefectPhotos.length})`, 0);
    });

    const btnAddEditStep = document.getElementById('btnAddEditRepStep');
    const inlineAddEditForm = document.getElementById('inlineAddEditRepStepForm');
    const inputNewEditStep = document.getElementById('inputNewEditRepStep');
    const btnConfirmAddEdit = document.getElementById('btnConfirmAddEditRepStep');
    const btnCancelAddEdit = document.getElementById('btnCancelAddEditRepStep');

    btnAddEditStep?.addEventListener('click', () => {
      inlineAddEditForm?.classList.remove('hidden');
      inlineAddEditForm?.classList.add('flex');
      inputNewEditStep?.focus();
    });

    btnCancelAddEdit?.addEventListener('click', () => {
      if (inputNewEditStep) inputNewEditStep.value = '';
      inlineAddEditForm?.classList.add('hidden');
      inlineAddEditForm?.classList.remove('flex');
    });

    function commitAddEditStep() {
      const val = inputNewEditStep?.value.trim();
      if (!val) {
        showToast('Required', 'Please type a step description before adding.', 'error');
        inputNewEditStep?.focus();
        return;
      }
      activeEditRepairSteps.push({
        id: 'task-' + Date.now().toString(36) + '-' + activeEditRepairSteps.length,
        name: val,
        status: 'Not Started'
      });
      if (inputNewEditStep) inputNewEditStep.value = '';
      inlineAddEditForm?.classList.add('hidden');
      inlineAddEditForm?.classList.remove('flex');
      renderEditRepStepsList();
      showToast('Step Added', `"${val}" added to repair steps.`, 'success');
    }

    btnConfirmAddEdit?.addEventListener('click', commitAddEditStep);
    inputNewEditStep?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitAddEditStep();
      } else if (e.key === 'Escape') {
        if (inputNewEditStep) inputNewEditStep.value = '';
        inlineAddEditForm?.classList.add('hidden');
        inlineAddEditForm?.classList.remove('flex');
      }
    });

    document.getElementById('btnSaveEditRepModal')?.addEventListener('click', saveEditRepairTaskModal);
  }

  function renderEditRepStepsList() {
    const listEl = document.getElementById('editRepStepsList');
    if (!listEl) return;
    if (activeEditRepairSteps.length === 0) {
      listEl.innerHTML = `<p class="text-xs text-gray-400 italic">No repair steps defined. Click "+ Add Repair Step" above.</p>`;
      return;
    }
    listEl.innerHTML = activeEditRepairSteps.map((step, idx) => `
      <div class="flex items-center gap-2 p-2 bg-white dark:bg-[#0a0f1d] border border-gray-200 dark:border-white/10 rounded-xl shadow-xs">
        <span class="checklist-step-badge badge-rose w-6 h-6 rounded-md bg-rose-600 text-white font-black text-xs flex items-center justify-center shrink-0 shadow-xs">${idx + 1}</span>
        <input type="text" class="flex-1 bg-transparent border-none text-xs font-bold text-gray-800 dark:text-gray-200 focus:outline-none" value="${step.name}" oninput="window.EcoTrackMaintenance._updateEditRepStepName(${idx}, this.value)">
        <span class="text-[10px] px-2 py-0.5 rounded font-bold ${step.status === 'Completed' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-gray-100 dark:bg-slate-800 text-gray-400'} shrink-0">${step.status || 'Not Started'}</span>
        <button type="button" class="text-gray-400 hover:text-rose-500 p-1 cursor-pointer" onclick="window.EcoTrackMaintenance._removeEditRepStep(${idx})" title="Remove step">✕</button>
      </div>
    `).join('');
  }

  function _updateEditRepStepName(idx, val) {
    if (activeEditRepairSteps && activeEditRepairSteps[idx]) {
      activeEditRepairSteps[idx].name = val;
    }
  }

  function _removeEditRepStep(idx) {
    if (activeEditRepairSteps && activeEditRepairSteps[idx]) {
      activeEditRepairSteps.splice(idx, 1);
      renderEditRepStepsList();
    }
  }

  async function saveEditRepairTaskModal() {
    const reports = getReports();
    const report = findReportById(reports, activeEditRepairId);
    if (!report) return;

    const compInput = document.getElementById('editRepComponentInput');
    const descInput = document.getElementById('editRepDescriptionInput');
    const staffSelect = document.getElementById('editRepStaffSelect');
    const prioritySelect = document.getElementById('editRepPrioritySelect');
    const dueDateInput = document.getElementById('editRepDueDateInput');

    const newComp = compInput ? compInput.value.trim() : '';
    const newDesc = descInput ? descInput.value.trim() : '';
    const newStaffId = resolveValidStaffId(staffSelect?.value || report.staff_id || report.staffId, report.staffName);
    const newStaff = getStaffList().find(s => s.id === newStaffId)?.name || report.staffName;
    const newPriority = prioritySelect ? prioritySelect.value.trim() : report.priority;
    const newDueDate = dueDateInput ? dueDateInput.value.trim() : report.dueDate;

    report.description = newDesc || report.description;
    report.priority = newPriority || report.priority;
    report.staffName = newStaff;
    report.staff_name = newStaff;
    report.staff_id = newStaffId;
    report.staffId = newStaffId;
    report.dueDate = newDueDate || report.dueDate;
    report.due_date = newDueDate || report.due_date;
    report.tasks = activeEditRepairSteps.map((s, i) => ({
      ...s,
      id: s.id || 'task-' + Date.now().toString(36) + '-' + i,
      name: s.name || `Step #${i + 1}`,
      status: s.status || 'Not Started',
      notes: s.notes || '',
      updated: 'Just now'
    }));

    if (report.issue) {
      if (newComp) report.issue.component = newComp;
      if (newDesc) report.issue.notes = newDesc;
    }

    safeTimelineUnshift(report.timeline, {
      title: 'Repair order updated by supervisor',
      time: 'Just now',
      done: true,
      by: 'Supervisor'
    });

    try { await saveReports(reports, report, false); }
    catch { return; }
    closeEditRepairTaskModal();
    showToast('Repair Order Updated', `Repair order ${report.id} updated successfully!`, 'success');
    refreshPageReportsView();
    if (currentDetailId === report.id) {
      renderDetailModalContent();
    }
  }

  function cycleRepairStepStatus(reportId, taskId) {
    const reports = getReports();
    const report = findReportById(reports, reportId);
    if (!report || !Array.isArray(report.tasks)) return;
    const task = report.tasks.find(t => String(t.id) === String(taskId) || t.id == taskId);
    if (!task) return;

    if (task.status === 'Not Started') task.status = 'In Progress';
    else if (task.status === 'In Progress') task.status = 'Completed';
    else task.status = 'Not Started';

    task.updated = 'Just now';
    const allDone = report.tasks.every(t => t.status === 'Completed');
    if (allDone) {
      report.status = 'For Verification';
      report.verified = false;
    } else if (report.tasks.some(t => t.status === 'In Progress' || t.status === 'Completed')) {
      report.status = 'In Progress';
      report.verified = false;
    } else {
      report.status = 'Pending';
      report.verified = false;
    }

    saveReports(reports, report, false, true).catch(() => {});
    renderDetailModalContent();
    refreshPageReportsView();
  }

  // ===================================================================
  // 3.9. EDIT REWORK ORDER REMOVED
  // ===================================================================
  function openEditReworkModal() {}
  function closeEditReworkModal() {}
  function injectEditReworkModalHTML() {}
  function renderEditReworkModalContent() {}
  function saveEditReworkModal() {}
  function cycleReworkTaskStatus() {}

  // ===================================================================
  // 3.10. DEDICATED CORRECTIVE REPAIR DETAIL MODAL VIEW (REP)
  // ===================================================================

  function renderRepDetailModalContent(report, aircon) {
    const equipment = maintenanceReportEquipment(report, aircon);
    const header = document.getElementById('ecoDetailModalHeader');
    const body = document.getElementById('ecoDetailModalBody');
    if (!header || !body) return;

    const totalTasks = Array.isArray(report.tasks) ? report.tasks.length : 0;
    const completedTasks = totalTasks > 0 ? report.tasks.filter(t => t.status === 'Completed' || t.repaired).length : 0;
    const pct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
    const allDone = totalTasks > 0 && completedTasks === totalTasks;

    const parentId = report.parentReportId || report.parent_report_id || null;
    const defectComp = report.issue?.component || (report.tasks && report.tasks[0]?.name) || 'Defective AC Component';
    const defectNotes = report.description || report.issue?.notes || 'Hardware defect diagnosed during inspection.';

    let statusBadge = `<span class="eco-status-info inline-flex items-center gap-1.5 px-3 py-1 text-xs font-bold rounded-full bg-cyan-100 dark:bg-cyan-950/80 text-cyan-900 dark:text-cyan-300 border border-cyan-400 dark:border-cyan-400/60 whitespace-nowrap shadow-sm"><span class="w-1.5 h-1.5 rounded-full bg-cyan-500 animate-pulse shrink-0"></span>In Progress</span>`;
    if (report.status === 'Completed' || report.status === 'Verified' || report.verified) {
      statusBadge = `<span class="eco-status-success inline-flex items-center gap-1.5 px-3 py-1 text-xs font-bold rounded-full bg-emerald-100 dark:bg-emerald-950/80 text-emerald-900 dark:text-emerald-300 border border-emerald-400 whitespace-nowrap shadow-sm"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0"></span>Completed ✓</span>`;
    } else if (allDone || report.status === 'For Verification' || report.status === 'Awaiting Admin Verification') {
      statusBadge = `<span class="eco-status-warning inline-flex items-center gap-1.5 px-3 py-1 text-xs font-bold rounded-full bg-purple-100 dark:bg-purple-950/80 text-purple-900 dark:text-purple-200 border border-purple-400 whitespace-nowrap shadow-sm"><span class="w-1.5 h-1.5 rounded-full bg-purple-600 animate-pulse shrink-0"></span>For Verification</span>`;
    }

    if (header.parentElement) {
      header.parentElement.className = "bg-white dark:bg-[#0c1328] border-2 border-rose-500/50 rounded-3xl w-full max-w-[980px] max-h-[90vh] shadow-2xl flex flex-col overflow-hidden text-gray-800 dark:text-gray-100 transition-colors";
    }
    header.className = "bg-white dark:bg-gradient-to-r dark:from-[#2d0f18] dark:to-[#0c1328] px-6 py-4 border-b border-rose-500/30 flex items-center justify-between flex-wrap gap-3 shrink-0 transition-colors";
    header.innerHTML = `
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-xl bg-rose-50 dark:bg-rose-500/20 border border-rose-500/40 flex items-center justify-center text-rose-500 dark:text-rose-400 shadow-sm shrink-0">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.3">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>
          </svg>
        </div>
        <div>
          <div class="flex items-center flex-wrap gap-2">
            <h2 class="text-lg font-bold text-gray-900 dark:text-white tracking-tight">Corrective Repair Order</h2>
            <span class="font-mono font-black text-rose-500 dark:text-rose-400">${report.id}</span>
            ${statusBadge}
            ${parentId ? `
              <button type="button" class="btn-goto-parent group inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-full cursor-pointer transition-all shadow-xs" data-id="${parentId}" title="View origin report ${parentId}">
                <span class="opacity-80 font-normal">Dispatched from</span>
                <span class="font-mono font-bold tracking-tight">${parentId}</span>
                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" class="shrink-0 opacity-80 group-hover:opacity-100 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform">
                  <path d="M7 17L17 7"></path>
                  <polyline points="7 7 17 7 17 17"></polyline>
                </svg>
              </button>
            ` : ''}
          </div>
          <p class="text-xs font-medium text-gray-500 dark:text-gray-400">Target: ${maintenanceDisplayText(equipment.controllerName)} — ${maintenanceDisplayText(equipment.location)} • Created: ${report.createdDate}</p>
        </div>
      </div>
      <div class="flex items-center gap-2">
        ${!((allDone || (totalTasks > 0 && completedTasks >= totalTasks) || String(report.status || '').toLowerCase().includes('complete') || String(report.status || '').toLowerCase().includes('verif') || report.verified)) ? `
        <button type="button" onclick="window.EcoTrackMaintenance.openEditRepairTaskModal('${report.id}')"
          class="px-3.5 py-1.5 rounded-xl bg-rose-50 dark:bg-rose-500/15 hover:bg-rose-500 hover:text-white dark:hover:bg-rose-500 dark:hover:text-white text-rose-700 dark:text-rose-300 border border-rose-400/50 flex items-center gap-1.5 text-xs font-bold transition-all cursor-pointer shadow-xs">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
          Edit Repair Order
        </button>
        ` : ''}
        <button id="btnCloseDetailModal"
          class="w-8 h-8 rounded-full bg-gray-100 dark:bg-white/15 hover:bg-rose-50 dark:hover:bg-rose-500/30 text-gray-600 dark:text-white hover:text-rose-600 border border-gray-200 dark:border-white/25 flex items-center justify-center text-sm font-bold transition-all cursor-pointer shadow-sm">
          ✕
        </button>
      </div>
    `;

    document.getElementById('btnCloseDetailModal')?.addEventListener('click', closeDetailModal);
    header.querySelectorAll('.btn-goto-parent').forEach(btn => {
      btn.addEventListener('click', () => {
        const pid = btn.getAttribute('data-id');
        if (pid) openDetailModal(pid);
      });
    });

    // Collect all defect proof evidence photos from report, issue, and parent report
    const _defectPhotoSet = new Set();
    const _addPhotos = (arrOrItem) => {
      if (!arrOrItem) return;
      if (Array.isArray(arrOrItem)) {
        arrOrItem.forEach(p => {
          if (typeof p === 'string' && p.trim()) {
            const r = resolvePhotoUrl(p.trim());
            if (r) _defectPhotoSet.add(r);
          }
        });
      } else if (typeof arrOrItem === 'string' && arrOrItem.trim()) {
        if (arrOrItem.trim().startsWith('[')) {
          try {
            const parsed = JSON.parse(arrOrItem);
            if (Array.isArray(parsed)) parsed.forEach(p => {
              if (p) {
                const r = resolvePhotoUrl(String(p).trim());
                if (r) _defectPhotoSet.add(r);
              }
            });
          } catch (_) {
            const r = resolvePhotoUrl(arrOrItem.trim());
            if (r) _defectPhotoSet.add(r);
          }
        } else {
          const r = resolvePhotoUrl(arrOrItem.trim());
          if (r) _defectPhotoSet.add(r);
        }
      }
    };

    if (report.issue?.photos) _addPhotos(report.issue.photos);
    if (report.issue?.photoUris) _addPhotos(report.issue.photoUris);
    if (report.photos) _addPhotos(report.photos);
    if (report.photoUris) _addPhotos(report.photoUris);
    if (report.photo_url) _addPhotos(report.photo_url);
    if (report.issue?.photoUri || report.issue?.photo) _addPhotos(report.issue.photoUri || report.issue.photo);

    if (_defectPhotoSet.size === 0 && (report.parentReportId || report.linkedParentId)) {
      const parentId = report.parentReportId || report.linkedParentId;
      const parent = findReportById(getReports(), parentId);
      if (parent && Array.isArray(parent.tasks)) {
        const pTask = parent.tasks.find(t =>
          (report.parentTaskId && String(t.id) === String(report.parentTaskId)) ||
          (report.parentTaskName && String(t.name).trim().toLowerCase() === String(report.parentTaskName).trim().toLowerCase()) ||
          (report.issue?.component && String(t.name).trim().toLowerCase() === String(report.issue.component).trim().toLowerCase())
        );
        if (pTask) {
          if (pTask.photos) _addPhotos(pTask.photos);
          if (pTask.photoUris) _addPhotos(pTask.photoUris);
          if (pTask.photo || pTask.photoUri) _addPhotos(pTask.photo || pTask.photoUri);
        }
      }
    }

    const defectPhotos = Array.from(_defectPhotoSet);

    body.innerHTML = `
      <!-- 1. DEFECT & DIAGNOSTIC BANNER (THE WHY) -->
      <div class="bg-gradient-to-r from-rose-500/10 via-rose-500/5 to-transparent dark:bg-gradient-to-r dark:from-rose-950/40 dark:to-transparent border-2 border-rose-500/40 rounded-2xl p-4 shadow-sm space-y-3">
        <div class="flex items-start justify-between gap-3">
          <div>
            <div class="flex items-center gap-2">
              <span class="text-[10px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded bg-rose-500 text-white shadow-xs">Defect Flagged</span>
              <span class="text-sm font-black text-gray-900 dark:text-white">${defectComp}</span>
            </div>
            <p class="text-xs font-medium text-gray-700 dark:text-gray-300 mt-2 leading-relaxed bg-white/70 dark:bg-slate-900/60 p-3 rounded-xl border border-rose-500/20">
              ${defectNotes}
            </p>
          </div>
          <div class="text-right shrink-0">
            <span class="text-[10px] uppercase font-bold text-gray-400 block">Priority</span>
            <span class="px-2.5 py-0.5 text-xs font-bold rounded-full ${report.priority === 'Critical' ? 'bg-rose-100 dark:bg-rose-500/20 text-rose-700 dark:text-rose-300 border border-rose-400/50' : 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-amber-400/50'}">
              ${report.priority || 'Critical'}
            </span>
          </div>
        </div>

        ${defectPhotos.length > 0 ? `
          <div class="bg-rose-500/5 dark:bg-rose-950/20 border border-rose-500/30 rounded-2xl p-3 space-y-2">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <span class="text-[10px] uppercase font-bold text-gray-700 dark:text-gray-300 flex items-center gap-1.5">
                  <svg class="w-3.5 h-3.5 text-rose-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                  Defect Proof Evidence
                </span>
                <span class="px-2 py-0.5 text-[10px] font-mono font-bold rounded-full bg-rose-500/15 text-rose-600 dark:text-rose-300 border border-rose-500/30">
                  ${defectPhotos.length} ${defectPhotos.length === 1 ? 'Photo' : 'Photos'}
                </span>
              </div>
              <div class="flex items-center gap-1.5">
                ${defectPhotos.length > 4 ? `
                  <button type="button" id="btnToggleDefectPhotosView" class="px-2 py-0.5 text-[10px] font-bold rounded-md bg-white dark:bg-slate-900 hover:bg-rose-50 dark:hover:bg-rose-950/40 text-rose-600 dark:text-rose-300 border border-rose-400/40 transition-all flex items-center gap-1 cursor-pointer shadow-2xs" title="Toggle between compact row and full grid">
                    <span id="txtToggleDefectPhotos">${window._defectEvidenceExpanded ? 'Minimize ▴' : 'Expand All ▾'}</span>
                  </button>
                ` : ''}
                <button type="button" id="btnOpenDefectGallery" class="px-2 py-0.5 text-[10px] font-bold rounded-md bg-rose-600 hover:bg-rose-500 text-white transition-all flex items-center gap-1 cursor-pointer shadow-xs" title="Open Fullscreen Gallery">
                  <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7"/></svg>
                  <span>Gallery</span>
                </button>
              </div>
            </div>

            <!-- Minimized Strip View (Default when > 4 photos, saves ~140px vertical space) -->
            <div id="defectPhotosCompactContainer" class="${(defectPhotos.length > 4 && !window._defectEvidenceExpanded) ? 'flex' : 'hidden'} items-center gap-2 overflow-x-auto eco-slim-scrollbar py-1 pb-1.5">
              ${defectPhotos.slice(0, 8).map((url, i) => `
                <div class="defect-evidence-thumbnail w-16 h-16 sm:w-20 sm:h-20 rounded-xl overflow-hidden border-2 border-rose-400/60 shadow-xs cursor-pointer hover:scale-105 hover:border-rose-500 transition-all relative group bg-black/20 shrink-0" data-idx="${i}" title="View proof evidence ${i + 1} of ${defectPhotos.length}">
                  <img src="${url}" class="w-full h-full object-cover" alt="Defect Photo ${i + 1}" loading="lazy" onerror="window.handlePhotoLoadError ? window.handlePhotoLoadError(this, ${i + 1}) : (this.onerror=null, this.parentElement.innerHTML='<div class=\\'w-full h-full flex items-center justify-center text-[9px] text-rose-400\\'>Photo</div>');">
                  <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white text-xs font-bold gap-1">
                    <span>🔍</span>
                    <span class="text-[9px]">${i + 1}</span>
                  </div>
                  <span class="absolute bottom-1 right-1 px-1 py-0.2 text-[8px] font-mono font-bold rounded bg-black/70 text-white backdrop-blur-xs">${i + 1}</span>
                </div>
              `).join('')}
              ${defectPhotos.length > 8 ? `
                <div id="btnDefectPhotosMorePill" class="w-16 h-16 sm:w-20 sm:h-20 rounded-xl border-2 border-dashed border-rose-400/60 hover:border-rose-500 bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 dark:text-rose-300 flex flex-col items-center justify-center cursor-pointer transition-all shrink-0 p-1 text-center shadow-xs" title="View all ${defectPhotos.length} photos">
                  <span class="text-xs font-black">+${defectPhotos.length - 8}</span>
                  <span class="text-[9px] font-bold">More</span>
                </div>
              ` : ''}
            </div>

            <!-- Expanded Grid View -->
            <div id="defectPhotosGridContainer" class="${(defectPhotos.length <= 4 || window._defectEvidenceExpanded) ? 'grid' : 'hidden'} grid-cols-4 sm:grid-cols-6 gap-2">
              ${defectPhotos.map((url, i) => `
                <div class="defect-evidence-thumbnail w-full aspect-square rounded-xl overflow-hidden border-2 border-rose-400/60 shadow-xs cursor-pointer hover:scale-105 hover:border-rose-500 transition-all relative group bg-black/20" data-idx="${i}" title="View proof evidence ${i + 1} of ${defectPhotos.length}">
                  <img src="${url}" class="w-full h-full object-cover" alt="Defect Photo ${i + 1}" loading="lazy" onerror="window.handlePhotoLoadError ? window.handlePhotoLoadError(this, ${i + 1}) : (this.onerror=null, this.parentElement.innerHTML='<div class=\\'w-full h-full flex items-center justify-center text-[9px] text-rose-400\\'>Photo</div>');">
                  <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white text-xs font-bold gap-1">
                    <span>🔍</span>
                    <span class="text-[9px]">${i + 1}</span>
                  </div>
                  <span class="absolute bottom-1 right-1 px-1 py-0.2 text-[8px] font-mono font-bold rounded bg-black/70 text-white backdrop-blur-xs">${i + 1}</span>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}
      </div>

      <!-- 2. TARGET UNIT & ASSIGNMENT STRIP (THE WHERE) -->
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
        <div class="bg-white dark:bg-slate-900/80 border border-gray-200 dark:border-white/10 rounded-xl p-3 shadow-xs">
          <span class="text-[10px] text-gray-400 font-bold uppercase block">Unit</span>
          <span class="text-xs font-bold text-gray-900 dark:text-white truncate block">${maintenanceDisplayText(equipment.controllerName)}</span>
          <span class="text-[10px] text-gray-500 dark:text-gray-400 block truncate">📍 ${maintenanceDisplayText(equipment.location)}</span>
        </div>
        <div class="bg-white dark:bg-slate-900/80 border border-gray-200 dark:border-white/10 rounded-xl p-3 shadow-xs">
          <span class="text-[10px] text-gray-400 font-bold uppercase block">Aircon Type</span>
          <span class="text-xs font-bold text-rose-600 dark:text-rose-400 truncate block">${maintenanceDisplayText(equipment.airconType)}</span>
          <span class="text-[10px] text-gray-500 dark:text-gray-400 block truncate">${aircon.state || 'Unavailable'}</span>
        </div>
        <div class="bg-white dark:bg-slate-900/80 border border-gray-200 dark:border-white/10 rounded-xl p-3 shadow-xs">
          <span class="text-[10px] text-gray-400 font-bold uppercase block">Assigned Specialist</span>
          <span class="text-xs font-bold text-gray-900 dark:text-white truncate block">${report.staffName || 'Unassigned'}</span>
          <span class="text-[10px] text-rose-500 font-semibold block truncate">Due: ${report.dueDate || 'ASAP'}</span>
        </div>
      </div>

      <!-- 3. REMEDIATION CHECKLIST STEPS (THE HOW) -->
      <div class="bg-white dark:bg-[#0c1426] border-2 border-rose-500/30 rounded-2xl p-4 shadow-sm space-y-3">
        <div class="flex items-center justify-between">
          <div>
            <h3 class="text-xs font-black uppercase tracking-wider text-gray-800 dark:text-gray-200 flex items-center gap-2">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" class="text-rose-500"><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>
              Step-by-Step Remediation Checklist
            </h3>
            <p class="text-[11px] text-gray-500 dark:text-gray-400">Click any step status pill to update completion progress</p>
          </div>
          <span class="px-2.5 py-1 text-xs font-mono font-bold rounded-lg ${allDone ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' : 'bg-rose-500/20 text-rose-300 border border-rose-500/40'}">
            ${completedTasks}/${totalTasks} (${pct}%)
          </span>
        </div>

        <!-- Progress Bar -->
        <div class="w-full bg-gray-200 dark:bg-slate-800 rounded-full h-2 overflow-hidden">
          <div class="h-full bg-gradient-to-r from-rose-500 to-emerald-500 rounded-full transition-all duration-300" style="width: ${pct}%"></div>
        </div>

        <!-- Steps List -->
        <div class="space-y-2 pt-1">
          ${(report.tasks || []).map((t, idx) => {
            const isDone = t.status === 'Completed' || t.repaired;
            const isInProg = t.status === 'In Progress';
            return `
              <div class="remediation-step-item group flex items-center justify-between gap-3 p-3 bg-gray-50 dark:bg-slate-900/90 hover:bg-rose-50/40 dark:hover:bg-slate-800/80 border border-gray-200 dark:border-white/10 hover:border-rose-500/40 rounded-xl transition-all cursor-pointer shadow-xs" data-step-id="${t.id}" data-step-name="${encodeURIComponent(t.name)}" title="Click to view step details & verify">
                <div class="flex items-center gap-2.5 min-w-0">
                  <span class="checklist-step-badge w-6 h-6 rounded-md ${isDone ? 'badge-emerald bg-emerald-500 text-white' : (isInProg ? 'badge-cyan bg-cyan-600 text-white' : 'badge-rose bg-rose-600 text-white')} font-black text-xs flex items-center justify-center shrink-0 shadow-xs">
                    ${isDone ? '✓' : (idx + 1)}
                  </span>
                  <div class="min-w-0">
                    <div class="flex items-center gap-2">
                      <span class="text-xs font-bold text-gray-800 dark:text-white group-hover:text-rose-600 dark:group-hover:text-rose-400 transition-colors block truncate ${isDone ? 'line-through text-gray-400 dark:text-gray-500' : ''}">${t.name}</span>
                      ${t.verified ? `<span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] font-bold rounded-full bg-emerald-100 dark:bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 border border-emerald-400/40 shrink-0">✓ Verified</span>` : ''}
                    </div>
                    ${t.notes ? `<span class="text-[10px] text-gray-500 block truncate">${t.notes}</span>` : ''}
                  </div>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                  <button type="button" class="btn-rep-cycle-step px-3 py-1 rounded-full text-xs font-bold shrink-0 cursor-pointer transition-all shadow-xs ${isDone ? 'bg-emerald-100 dark:bg-emerald-950/80 text-emerald-800 dark:text-emerald-300 border border-emerald-400' : (isInProg ? 'bg-cyan-100 dark:bg-cyan-950/80 text-cyan-800 dark:text-cyan-300 border border-cyan-400 animate-pulse' : 'bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-gray-400 border border-gray-300 dark:border-slate-700')}" data-step-id="${t.id}" title="Toggle status">
                    ${isDone ? 'Completed ✓' : (isInProg ? 'In Progress ⏳' : 'Not Started')}
                  </button>
                  <svg class="w-4 h-4 text-gray-400 group-hover:text-rose-500 group-hover:translate-x-0.5 transition-all" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>

      <!-- 4. ACTION BAR & VERIFICATION -->
      <div class="flex items-center justify-between pt-2">
        <span class="text-xs font-medium text-gray-500 dark:text-gray-400">
          ${allDone ? '🎉 All repair steps completed! Ready to verify and close order.' : 'Work in progress. Update steps as repairs conclude.'}
        </span>
        <div class="flex items-center gap-2">
          ${(report.status === 'Completed' || report.status === 'Verified' || report.verified) ? `
            <div class="px-4 py-2 rounded-xl bg-emerald-100 dark:bg-emerald-950/80 text-emerald-800 dark:text-emerald-300 border border-emerald-400 font-bold text-xs flex items-center gap-2 select-none shadow-xs">
              <span class="w-2 h-2 rounded-full bg-emerald-500"></span>
              <span>Completed</span>
            </div>
          ` : (!allDone ? `
            <button type="button" disabled class="px-5 py-2 rounded-xl bg-cyan-50 dark:bg-cyan-950/50 text-cyan-700 dark:text-cyan-300 border border-cyan-400/50 font-bold text-xs cursor-default flex items-center gap-2 select-none shadow-xs">
              <span class="w-2 h-2 rounded-full bg-cyan-500 animate-pulse"></span>
              <span>In Progress</span>
            </button>
          ` : `
            <button type="button" id="btnVerifyRepOrder" class="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs rounded-xl shadow-md shadow-emerald-600/30 border border-emerald-400 transition-all cursor-pointer flex items-center gap-1.5">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
              <span>Verify Report</span>
            </button>
          `)}
        </div>
      </div>
    `;

    // Click step row to open detail modal
    body.querySelectorAll('.remediation-step-item').forEach((item, idx) => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.btn-rep-cycle-step')) return;
        const sid = item.getAttribute('data-step-id');
        const sname = decodeURIComponent(item.getAttribute('data-step-name') || '');
        const targetId = (sid && sid !== 'undefined' && sid !== 'NaN') ? sid : (sname || (idx + 1));
        openChecklistItemModal(report.id, targetId);
      });
    });

    body.querySelectorAll('.btn-rep-cycle-step').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sid = btn.getAttribute('data-step-id');
        cycleRepairStepStatus(report.id, sid);
      });
    });

    body.querySelectorAll('.defect-evidence-thumbnail').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.getAttribute('data-idx') || '0', 10);
        openImageLightbox(defectPhotos, `Defect Evidence Photo ${idx + 1} of ${defectPhotos.length}`, idx);
      });
    });

    const btnToggle = body.querySelector('#btnToggleDefectPhotosView');
    if (btnToggle) {
      btnToggle.addEventListener('click', () => {
        window._defectEvidenceExpanded = !window._defectEvidenceExpanded;
        const compact = body.querySelector('#defectPhotosCompactContainer');
        const grid = body.querySelector('#defectPhotosGridContainer');
        const txt = body.querySelector('#txtToggleDefectPhotos');
        if (window._defectEvidenceExpanded) {
          compact?.classList.add('hidden');
          compact?.classList.remove('flex');
          grid?.classList.remove('hidden');
          grid?.classList.add('grid');
          if (txt) txt.textContent = 'Minimize ▴';
        } else {
          compact?.classList.remove('hidden');
          compact?.classList.add('flex');
          grid?.classList.add('hidden');
          grid?.classList.remove('grid');
          if (txt) txt.textContent = `Expand All (${defectPhotos.length}) ▾`;
        }
      });
    }

    body.querySelector('#btnDefectPhotosMorePill')?.addEventListener('click', () => {
      openImageLightbox(defectPhotos, `Defect Evidence Photo 9 of ${defectPhotos.length}`, 8);
    });

    body.querySelector('#btnOpenDefectGallery')?.addEventListener('click', () => {
      openImageLightbox(defectPhotos, `Defect Evidence Gallery (1 of ${defectPhotos.length})`, 0);
    });

    document.getElementById('btnVerifyRepOrder')?.addEventListener('click', async () => {
      const reports = getReports();
      const r = findReportById(reports, report.id);
      if (r) {
        r.status = 'Completed';
        r.verified = true;
        if (Array.isArray(r.tasks)) {
          r.tasks.forEach(t => {
            t.status = 'Completed';
            t.verified = true;
            if (!t.verifiedAt) t.verifiedAt = new Date().toISOString();
          });
        }
        safeTimelineUnshift(r.timeline, {
          title: 'Repair report verified and signed off by supervisor',
          time: 'Just now',
          done: true,
          by: 'Supervisor'
        });

        try { await saveReports(reports, r, false); }
        catch { return; }

        // Synchronize and update the linked parent maintenance report
        const pId = r.parentReportId || r.parent_report_id || r.linkedParentId;
        let parentRep = pId ? findReportById(reports, pId) : null;
        if (!parentRep && r.airconId) {
          parentRep = reports.find(pr => pr && pr.id !== r.id && (pr.id === pId || pr.linkedRepairId === r.id || (Array.isArray(pr.tasks) && pr.tasks.some(t => t.linkedRepairId === r.id))));
        }

        if (parentRep) {
          if (Array.isArray(parentRep.tasks)) {
            // Strictly target ONLY the parent task linked to this specific repair order
            let targetParentTask = parentRep.tasks.find(pt => pt.linkedRepairId && String(pt.linkedRepairId).trim().toLowerCase() === String(r.id).trim().toLowerCase());
            if (!targetParentTask && (r.parentTaskId !== undefined && r.parentTaskId !== null)) {
              targetParentTask = parentRep.tasks.find(pt => String(pt.id) === String(r.parentTaskId));
            }
            if (!targetParentTask && r.parentTaskName) {
              targetParentTask = parentRep.tasks.find(pt => String(pt.name || '').trim().toLowerCase() === String(r.parentTaskName).trim().toLowerCase());
            }
            if (!targetParentTask && r.issue?.component) {
              targetParentTask = parentRep.tasks.find(pt => String(pt.name || '').trim().toLowerCase() === String(r.issue.component).trim().toLowerCase());
            }

            if (targetParentTask) {
              targetParentTask.status = 'Completed';
              targetParentTask.repaired = true;
              targetParentTask.verified = true;
              targetParentTask.linkedRepairId = r.id;
              targetParentTask.updated = 'Just now';
              if (!targetParentTask.verifiedAt) targetParentTask.verifiedAt = new Date().toISOString();
            }
          }

          // Check if there are remaining unfinished tasks or child repairs
          const hasRemainingNeedsRepair = Array.isArray(parentRep.tasks) && parentRep.tasks.some(pt => pt.status === 'Needs Repair' && !pt.repaired);
          const hasRemainingUnderRepair = Array.isArray(parentRep.tasks) && parentRep.tasks.some(pt => {
            const cr = getRepairReportForTask(parentRep, pt, reports);
            if (cr && String(cr.id).toLowerCase() !== String(r.id).toLowerCase() && !isRepairReportDone(cr)) return true;
            return pt.status === 'Under Repair' && !pt.repaired;
          });
          const allParentDone = Array.isArray(parentRep.tasks) && parentRep.tasks.length > 0 && parentRep.tasks.every(pt => {
            const cr = getRepairReportForTask(parentRep, pt, reports);
            if (cr && String(cr.id).toLowerCase() !== String(r.id).toLowerCase() && !isRepairReportDone(cr)) return false;
            return pt.status === 'Completed' || pt.repaired;
          });
          const allParentVerified = allParentDone && parentRep.tasks.every(pt => pt.verified);

          if (hasRemainingNeedsRepair) {
            parentRep.status = 'Needs Repair';
            parentRep.verified = false;
            if (parentRep.issue) {
              parentRep.issue.repaired = false;
              parentRep.issue.status = 'Needs Repair';
            }
          } else if (hasRemainingUnderRepair) {
            parentRep.status = 'Under Repair';
            parentRep.verified = false;
            if (parentRep.issue) {
              parentRep.issue.repaired = false;
              parentRep.issue.status = 'Under Repair';
            }
          } else if (allParentVerified) {
            parentRep.status = 'Completed';
            parentRep.verified = true;
            if (parentRep.issue) {
              parentRep.issue.repaired = true;
              parentRep.issue.status = 'Repaired';
            }
          } else if (allParentDone) {
            parentRep.status = 'For Verification';
            if (parentRep.issue) {
              parentRep.issue.repaired = true;
              parentRep.issue.status = 'Repaired';
            }
          }

          safeTimelineUnshift(parentRep.timeline, {
            title: `Repair ${r.id} verified by Supervisor${hasRemainingUnderRepair ? ' (other repairs still in progress)' : ''}`,
            time: 'Just now',
            done: true,
            by: 'Supervisor'
          });

          try {
            await saveReports(reports, parentRep, false);
          } catch (pErr) {
            console.warn('[btnVerifyRepOrder] Parent report save notice:', pErr);
            return;
          }
        }


        closeDetailModal();
        showToast('Report Verified', `Repair order ${r.id} verified and maintenance marked Completed!`, 'success');
        refreshPageReportsView();
        window.dispatchEvent(new Event('storage'));
        window.dispatchEvent(new CustomEvent('ecotrack:reports-updated', { detail: _reportsCache }));
        broadcastMaintenanceChange('REPAIR_VERIFIED');
      }
    });
  }

  // ===================================================================
  // 3.11. REWORK DETAIL VIEW REMOVED
  // ===================================================================
  function renderReworkDetailModalContent() {}

  function injectDetailModalHTML() {
    if (document.getElementById('ecoReportDetailModal')) return;

    const modalHTML = `
      <div id="ecoReportDetailModal" class="hidden fixed inset-0 bg-slate-950/70 backdrop-blur-sm z-[9998] flex items-center justify-center p-3 sm:p-5">
        <div class="bg-white dark:bg-[#0c1328] border-2 border-gray-200 dark:border-[#10b981]/50 rounded-3xl w-full max-w-[980px] max-h-[90vh] shadow-2xl flex flex-col overflow-hidden text-gray-800 dark:text-gray-100 transition-colors">
          <div id="ecoDetailModalHeader" class="bg-white dark:bg-gradient-to-r dark:from-[#0b291d] dark:to-[#081a14] px-6 py-4 border-b border-gray-200 dark:border-[#10b981]/30 flex items-center justify-between shrink-0 transition-colors">
            <!-- Injected by renderDetailModalContent -->
          </div>
          <div id="ecoDetailModalBody" class="p-5 overflow-y-auto flex-1 bg-gray-50 dark:bg-[#0a0f1d]/90 space-y-4 text-gray-800 dark:text-gray-100">
            <!-- Injected by renderDetailModalContent -->
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHTML);

    const modal = document.getElementById('ecoReportDetailModal');
    modal?.addEventListener('click', (e) => {
      if (e.target === modal) closeDetailModal();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) {
        closeDetailModal();
      }
    });
  }

  function renderDetailModalContent() {
    const reports = getReports();
    const report = findReportById(reports, currentDetailId) || reports[0];
    if (!report) {
      console.warn('[EcoTrack Maintenance] No report available to display for ID:', currentDetailId);
      return;
    }

    const aircon = findMaintenanceAircon(report) || {};
    const equipment = maintenanceReportEquipment(report, aircon);

    const isRepReport = isActualRepairTask(report);
    

    if (isRepReport) {
      renderRepDetailModalContent(report, aircon);
      return;
    }



    // Locate child corrective repair reports
    const childRepairs = getChildRepairReportsFor(report, reports);
    if (!isRepReport && Array.isArray(report.tasks)) {
      report.tasks.forEach(t => {
        const tRepair = getRepairReportForTask(report, t, reports);
        if (tRepair) {
          t.linkedRepairId = tRepair.id;
          const tDone = isRepairReportDone(tRepair);
          const tVerified = isRepairReportVerified(tRepair);
          if (tVerified) {
            t.status = 'Completed';
            t.repaired = true;
            t.verified = true;
            if (!t.verifiedAt) t.verifiedAt = new Date().toISOString();
          } else if (tDone) {
            t.status = 'Completed';
            t.repaired = true;
            t.verified = false;
          } else {
            t.status = 'Under Repair';
            t.repaired = false;
            t.verified = false;
          }
          if (!t.photo && Array.isArray(tRepair.tasks)) {
            const rPhotoTask = tRepair.tasks.find(rt => rt.photo || rt.photoUri);
            if (rPhotoTask) {
              t.photo = rPhotoTask.photo || rPhotoTask.photoUri;
              t.photoUri = t.photo;
            }
          }
        } else if (report.issue && isComponentInIssue(t.name, report.issue) && !t.repaired && t.status !== 'Completed' && !t.linkedRepairId) {
          t.status = 'Needs Repair';
        }
      });
    }

    const completedChildRepairs = childRepairs.filter(cr => isRepairReportDone(cr));
    const activeChildRepairs = childRepairs.filter(cr => !isRepairReportDone(cr));
    const isAllRepairsDone = childRepairs.length > 0 ? (activeChildRepairs.length === 0) : Boolean(report.issue?.repaired);
    const isAllRepairsVerified = childRepairs.length > 0 ? (childRepairs.length === completedChildRepairs.filter(cr => isRepairReportVerified(cr)).length) : Boolean(report.verified);

    const repairReport = activeChildRepairs[0] || completedChildRepairs[0] || getRepairReportFor(report, reports);
    const isRepairDone = isAllRepairsDone;
    const isRepairVerified = isAllRepairsVerified;

    const totalTasks = report.tasks ? report.tasks.length : 0;
    const completedTasks = report.tasks ? report.tasks.filter(t => t.status === 'Completed' || t.repaired).length : 0;
    const inProgressTasks = report.tasks ? report.tasks.filter(t => t.status === 'In Progress').length : 0;
    const notStartedTasks = report.tasks ? report.tasks.filter(t => t.status === 'Not Started').length : 0;
    const needsRepairTasks = isRepReport ? 0 : (report.tasks ? report.tasks.filter(t => t.status === 'Needs Repair' && !t.repaired).length : 0);
    const underRepairTasks = isRepReport ? 0 : (report.tasks ? report.tasks.filter(t => (t.status === 'Under Repair' || (t.linkedRepairId && !isRepairReportDone(getRepairReportForTask(report, t, reports)))) && !t.repaired).length : 0);

    const hasActiveIssue = !isRepReport && Boolean(report.issue && !report.issue.repaired && !isRepairDone && report.issue.status !== 'Under Repair' && !repairReport);
    const hasNeedsRepair = !isRepReport && (needsRepairTasks > 0 || hasActiveIssue);
    const pct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
    const isAllTasksCompleted = totalTasks > 0 && completedTasks === totalTasks && !hasNeedsRepair && underRepairTasks === 0 && activeChildRepairs.length === 0;

    if (underRepairTasks > 0 || activeChildRepairs.length > 0) {
      report.status = 'Under Repair';
      report.verified = false;
      if (report.issue) {
        report.issue.repaired = false;
        report.issue.status = 'Under Repair';
      }
    } else if (hasNeedsRepair) {
      report.status = 'Needs Repair';
      report.verified = false;
      if (!report.issue && needsRepairTasks > 0) {
        const repTasks = report.tasks.filter(t => t.status === 'Needs Repair' && !t.repaired);
        if (repTasks.length > 0) {
          report.issue = {
            component: repTasks.map(t => t.name).join(', '),
            components: repTasks.map(t => t.name),
            notes: repTasks.length === 1 ? (repTasks[0].notes || 'Maintenance defect requires repair.') : repTasks.map(t => `${t.name}: ${t.notes || 'Defect reported'}`).join(' • ')
          };
        }
      }
    } else if (report.status === 'Closed') {
      report.status = 'Closed';
    } else if (report.status === 'Completed' || report.status === 'Verified' || (report.verified && isAllTasksCompleted)) {
      if (isAllTasksCompleted) {
        report.status = 'Completed';
        report.verified = true;
      } else {
        report.status = 'In Progress';
      }
    } else if (isAllTasksCompleted || report.status === 'For Verification' || report.status === 'Awaiting Admin Verification') {
      report.status = 'For Verification';
    } else if (isRepReport) {
      report.status = 'In Progress';
    } else {
      report.status = 'In Progress';
    }

    const isVerified = (report.status === 'Completed' || report.status === 'Verified' || Boolean(report.verified && isAllTasksCompleted)) && activeChildRepairs.length === 0 && underRepairTasks === 0;
    const isReadyForVerification = !isVerified && !hasNeedsRepair && (report.status === 'For Verification' || (isAllTasksCompleted && !report.verified));

    const repairTask = report.tasks ? (report.tasks.find(t => t.status === 'Needs Repair' && !t.repaired) || report.tasks.find(t => t.status === 'Under Repair') || report.tasks.find(t => t.repaired)) : null;
    const repairComponentName = report.issue?.component || repairTask?.name || (repairReport?.tasks?.[1]?.name ? repairReport.tasks[1].name.replace(/^Component Disassembly & Diagnostic Check:\s*/i, '') : 'Defect Component');
    const repairNotes = (repairReport && repairReport.verificationRemarks) || report.issue?.notes || repairTask?.notes || 'Maintenance defect resolved.';
    const matchedRepairedTask = report.tasks ? report.tasks.find(t => t.repaired || (String(t.name || '').toLowerCase().trim() === String(repairComponentName).toLowerCase().trim())) : null;

    const acHistory = reports.filter(r => (r.airconId === report.airconId || r.aircon_name === report.aircon_name) && r.id !== report.id);
    const staffList = getStaffList();
    const assignedStaffMember = staffList.find(s => s.name === report.staffName || s.name === report.staff_name);

    // Render Header
    const header = document.getElementById('ecoDetailModalHeader');
    if (header) {
      if (header.parentElement) {
        header.parentElement.className = "bg-white dark:bg-[#0c1328] border-2 border-gray-200 dark:border-[#10b981]/50 rounded-3xl w-full max-w-[980px] max-h-[90vh] shadow-2xl flex flex-col overflow-hidden text-gray-800 dark:text-gray-100 transition-colors";
      }
      header.className = "bg-white dark:bg-gradient-to-r dark:from-[#0b291d] dark:to-[#081a14] px-6 py-4 border-b border-gray-200 dark:border-[#10b981]/30 flex items-center justify-between flex-wrap gap-3 shrink-0 transition-colors";
      let statusBadge = `<span class="eco-status-neutral inline-flex items-center gap-1.5 px-3 py-1 text-xs font-bold rounded-full bg-gray-100 dark:bg-slate-800 text-gray-800 dark:text-gray-300 border border-gray-300 dark:border-slate-700 whitespace-nowrap shadow-sm"><span class="w-1.5 h-1.5 rounded-full bg-gray-600 dark:bg-gray-400 shrink-0"></span>${report.status}</span>`;
      if ((report.status === 'Completed' || report.status === 'Verified' || isVerified) && activeChildRepairs.length === 0 && underRepairTasks === 0) {
        statusBadge = `<span class="eco-status-success inline-flex items-center gap-1.5 px-3 py-1 text-xs font-bold rounded-full bg-emerald-100 dark:bg-emerald-950/80 text-emerald-900 dark:text-emerald-300 border border-emerald-400 dark:border-emerald-400/60 whitespace-nowrap shadow-sm"><span class="w-1.5 h-1.5 rounded-full bg-emerald-600 dark:bg-emerald-400 shrink-0"></span>Completed ✓</span>`;
      } else if (report.status === 'For Verification' || isReadyForVerification || report.status === 'Awaiting Admin Verification') {
        statusBadge = `<span class="eco-status-warning inline-flex items-center gap-1.5 px-3 py-1 text-xs font-bold rounded-full bg-purple-100 dark:bg-purple-950/80 text-purple-900 dark:text-purple-200 border border-purple-400 dark:border-purple-400/60 whitespace-nowrap shadow-sm"><span class="w-1.5 h-1.5 rounded-full bg-purple-600 dark:bg-purple-400 animate-pulse shrink-0"></span>For Verification</span>`;
      } else if (report.status === 'In Progress') {
        statusBadge = `<span class="eco-status-info inline-flex items-center gap-1.5 px-3 py-1 text-xs font-bold rounded-full bg-cyan-100 dark:bg-cyan-950/80 text-cyan-900 dark:text-cyan-300 border border-cyan-400 dark:border-cyan-400/60 whitespace-nowrap shadow-sm"><span class="w-1.5 h-1.5 rounded-full bg-cyan-600 dark:bg-cyan-400 animate-pulse shrink-0"></span>In Progress</span>`;
      } else if (report.status === 'Pending') {
        statusBadge = `<span class="eco-status-neutral inline-flex items-center gap-1.5 px-3 py-1 text-xs font-bold rounded-full bg-amber-100 dark:bg-amber-950/80 text-amber-900 dark:text-amber-300 border border-amber-400 dark:border-amber-400/60 whitespace-nowrap shadow-sm"><span class="w-1.5 h-1.5 rounded-full bg-amber-600 dark:bg-amber-400 shrink-0"></span>Pending</span>`;

      } else if (report.status === 'Completed') {
        statusBadge = `<span class="eco-status-success inline-flex items-center gap-1.5 px-3 py-1 text-xs font-bold rounded-full bg-emerald-100 dark:bg-emerald-950/80 text-emerald-900 dark:text-emerald-300 border border-emerald-400 dark:border-emerald-400/60 whitespace-nowrap shadow-sm"><span class="w-1.5 h-1.5 rounded-full bg-emerald-600 dark:bg-emerald-400 shrink-0"></span>Completed</span>`;
      } else if (report.status === 'Needs Repair') {
        statusBadge = `<span class="eco-status-danger inline-flex items-center gap-1.5 px-3 py-1 text-xs font-extrabold rounded-full bg-rose-100 dark:bg-rose-950/90 text-rose-900 dark:text-rose-300 border border-rose-400 dark:border-rose-500/70 whitespace-nowrap shadow-sm"><span class="w-1.5 h-1.5 rounded-full bg-rose-600 dark:bg-rose-500 shrink-0"></span>Needs Repair</span>`;
      } else if (report.status === 'Under Repair') {
        statusBadge = `<span class="eco-status-info inline-flex items-center gap-1.5 px-3 py-1 text-xs font-extrabold rounded-full bg-cyan-100 dark:bg-cyan-950/90 text-cyan-900 dark:text-cyan-300 border border-cyan-400 dark:border-cyan-400/70 whitespace-nowrap shadow-sm"><span class="w-1.5 h-1.5 rounded-full bg-cyan-500 animate-pulse shrink-0"></span>Under Repair</span>`;
      } else if (report.status === 'Assigned') {
        statusBadge = `<span class="eco-status-info inline-flex items-center gap-1.5 px-3 py-1 text-xs font-bold rounded-full bg-sky-100 dark:bg-sky-950/80 text-sky-900 dark:text-sky-300 border border-sky-400 dark:border-sky-400/60 whitespace-nowrap shadow-sm"><span class="w-1.5 h-1.5 rounded-full bg-sky-600 dark:bg-sky-400 shrink-0"></span>Assigned</span>`;
      }

      header.innerHTML = `
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl bg-emerald-50 dark:bg-emerald-500/20 border border-emerald-500/30 dark:border-emerald-400/50 flex items-center justify-center text-[#10b981] dark:text-emerald-300 shadow-sm">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
            </svg>
          </div>
          <div>
            <div class="flex items-center flex-wrap gap-2">
              <h2 class="text-lg font-bold text-[#18392B] dark:text-white tracking-tight">Maintenance Report</h2>
              <span class="font-mono font-black text-[#10b981] dark:text-cyan-400">${report.id}</span>
              ${statusBadge}
              ${isRepairDone ? `
                <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 text-xs font-extrabold rounded-full bg-emerald-100 dark:bg-emerald-950/80 text-emerald-800 dark:text-emerald-300 border border-emerald-400 dark:border-emerald-500/60 whitespace-nowrap shadow-xs">
                  <span class="w-1.5 h-1.5 rounded-full bg-emerald-600 dark:bg-emerald-400 shrink-0"></span>
                  Repaired ✓
                </span>
              ` : ''}
            </div>
            <p class="text-xs font-medium text-gray-500 dark:text-gray-400">${maintenanceDisplayText(equipment.controllerName)} — ${maintenanceDisplayText(equipment.location)} • Created on ${report.createdDate} • Last updated ${formatMaintenanceUpdateTime(report.updated || report.updated_at, 'Not updated yet')}</p>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <button id="btnDetailEditReport" type="button"
            class="px-3 py-1.5 rounded-xl bg-emerald-50 dark:bg-emerald-500/15 hover:bg-emerald-600 hover:text-white dark:hover:bg-emerald-500 dark:hover:text-white text-emerald-700 dark:text-emerald-300 border border-emerald-400/50 flex items-center gap-1.5 text-xs font-bold transition-all cursor-pointer shadow-xs"
            title="Edit Report">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            Edit
          </button>
          <button id="btnDetailDeleteReport" type="button"
            class="px-3 py-1.5 rounded-xl bg-rose-50 dark:bg-rose-500/15 hover:bg-rose-600 hover:text-white dark:hover:bg-rose-500 dark:hover:text-white text-rose-700 dark:text-rose-300 border border-rose-400/50 flex items-center gap-1.5 text-xs font-bold transition-all cursor-pointer shadow-xs"
            title="Delete Report">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.3"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            Delete
          </button>
          <button id="btnCloseDetailModal"
            class="w-8 h-8 rounded-full bg-gray-100 dark:bg-white/15 hover:bg-rose-50 dark:hover:bg-rose-500/30 text-gray-600 dark:text-white hover:text-rose-600 border border-gray-200 dark:border-white/25 flex items-center justify-center text-sm font-bold transition-all cursor-pointer shadow-sm">
            ✕
          </button>
        </div>
      `;
      document.getElementById('btnCloseDetailModal')?.addEventListener('click', closeDetailModal);
      document.getElementById('btnDetailEditReport')?.addEventListener('click', () => {
        const targetId = report.id;
        closeDetailModal();
        if (isActualRepairTask(report)) {
          openEditRepairTaskModal(targetId);
        } else {
          openEditReportModal(targetId);
        }
      });
      document.getElementById('btnDetailDeleteReport')?.addEventListener('click', async () => {
        if (await window.EcoModal.confirm({ title: 'Delete Report',
          message: `Are you sure you want to permanently delete report ${report.id}?`,
          confirmText: 'Delete Report', danger: true })) {
          closeDetailModal();
          deleteReports([report.id]);
        }
      });
    }

    // Render Body
    const body = document.getElementById('ecoDetailModalBody');
    if (body) {
      body.innerHTML = `
        <!-- META OVERVIEW -->
        <div class="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <div class="bg-white dark:bg-slate-900/80 border border-gray-200 dark:border-white/10 rounded-xl p-3 shadow-sm">
            <span class="text-[10px] text-gray-500 dark:text-gray-400 font-bold uppercase block">${maintenanceDeviceLabel()} Name</span>
            <span class="text-xs font-bold text-gray-800 dark:text-white truncate block">${maintenanceDisplayText(equipment.controllerName)}</span>
            <span class="text-[10px] text-gray-500 dark:text-gray-400 block truncate">📍 ${maintenanceDisplayText(equipment.location)}</span>
          </div>
          <div class="bg-white dark:bg-slate-900/80 border border-gray-200 dark:border-white/10 rounded-xl p-3 shadow-sm">
            <span class="text-[10px] text-gray-500 dark:text-gray-400 font-bold uppercase block">Type of Aircon</span>
            <span class="text-xs font-bold text-[#18392B] dark:text-cyan-300 truncate block">${maintenanceDisplayText(equipment.airconType)}</span>
            <span class="text-[10px] text-gray-500 dark:text-gray-400 block truncate">${maintenanceDisplayText(equipment.airconName)}</span>
          </div>
          <div class="bg-white dark:bg-slate-900/80 border border-gray-200 dark:border-white/10 rounded-xl p-3 shadow-sm">
            <span class="text-[10px] text-gray-500 dark:text-gray-400 font-bold uppercase block">Maintenance Type</span>
            <span class="text-xs font-bold text-gray-800 dark:text-white truncate block">${report.type}</span>
          </div>
          <div class="bg-white dark:bg-slate-900/80 border border-gray-200 dark:border-white/10 rounded-xl p-3 shadow-sm">
            <span class="text-[10px] text-gray-500 dark:text-gray-400 font-bold uppercase block mb-1">Priority</span>
            <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-bold ${report.priority === 'Critical' ? 'bg-rose-50 dark:bg-rose-950/70 text-rose-700 dark:text-rose-300 border border-rose-400/50' : (report.priority === 'High' ? 'bg-amber-50 dark:bg-amber-950/70 text-amber-800 dark:text-amber-300 border border-amber-400/50' : (report.priority === 'Medium' ? 'bg-sky-50 dark:bg-sky-950/70 text-sky-800 dark:text-sky-300 border border-sky-400/50' : 'bg-emerald-50 dark:bg-emerald-950/70 text-emerald-800 dark:text-emerald-300 border border-emerald-400/50'))}">
              <span class="w-1.5 h-1.5 rounded-full ${report.priority === 'Critical' ? 'bg-rose-500' : (report.priority === 'High' ? 'bg-amber-500' : (report.priority === 'Medium' ? 'bg-sky-500' : 'bg-emerald-500'))} shrink-0"></span>
              ${report.priority}
            </span>
          </div>
          <div class="col-span-2 sm:col-span-1 bg-white dark:bg-slate-900/80 border border-gray-200 dark:border-white/10 rounded-xl p-3 shadow-sm flex items-center gap-2.5">
            ${(() => {
          const detailPhoto = resolveStaffAvatar(assignedStaffMember || report.staffName);
          const initials = (report.staffName || 'ST').split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
          return `
                <div class="w-9 h-9 rounded-full overflow-hidden border-2 border-[#10b981] bg-emerald-100 dark:bg-emerald-950 flex items-center justify-center font-bold text-xs text-[#10b981] shrink-0">
                  ${detailPhoto ? `
                    <img src="${detailPhoto}" alt="${report.staffName}" class="w-full h-full object-cover" onerror="this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.style.display='flex';">
                    <span style="display:none;" class="w-full h-full flex items-center justify-center font-bold text-xs text-[#10b981]">${initials}</span>
                  ` : `
                    <span class="font-bold text-xs text-[#10b981]">${initials}</span>
                  `}
                </div>
              `;
        })()}
            <div class="min-w-0">
              <span class="text-[10px] text-gray-500 dark:text-gray-400 font-bold uppercase block">Assigned Staff</span>
              <span class="text-xs font-bold text-[#10b981] truncate block">${report.staffName}</span>
              <span class="text-[10px] text-gray-500 dark:text-gray-400 block truncate">${assignedStaffMember?.role || 'Technician'} • Due: ${report.dueDate}</span>
            </div>
          </div>
        </div>

        <section aria-label="Scope / Description" class="bg-white dark:bg-slate-900/80 border border-gray-200 dark:border-emerald-500/30 rounded-2xl p-4 shadow-sm">
          <h4 class="text-xs font-bold text-[#18392B] dark:text-cyan-300 uppercase tracking-wider mb-2">Scope / Description</h4>
          <p class="text-sm text-gray-800 dark:text-gray-100 leading-relaxed whitespace-pre-wrap break-words">${maintenanceDisplayText(report.description || 'No description provided.')}</p>
        </section>

        <!-- PROGRESS SECTION -->
        <div class="bg-white dark:bg-[#081a14] border-2 border-emerald-500/30 dark:border-[#10b981]/40 rounded-2xl p-4 shadow-sm">
          <div class="flex items-center justify-between mb-2">
            <div>
              <h4 class="text-xs font-bold text-[#18392B] dark:text-cyan-300 uppercase tracking-wider">Maintenance Progress</h4>
              <span class="text-base font-black text-gray-800 dark:text-white">${completedTasks} / ${totalTasks} Tasks Completed</span>
            </div>
            <span class="text-lg font-black text-[#10b981] font-mono">${pct}%</span>
          </div>
          <div class="w-full bg-gray-200 dark:bg-slate-900 rounded-full h-3 overflow-hidden border border-gray-300 dark:border-[#10b981]/30 mb-3">
            <div class="h-full bg-gradient-to-r from-[#10b981] via-teal-400 to-cyan-400 rounded-full transition-all duration-300" style="width: ${pct}%"></div>
          </div>
          <div class="${isRepReport ? 'grid grid-cols-3 gap-2 text-xs' : 'grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs'}">
            <div class="bg-emerald-50 dark:bg-slate-950/80 border border-emerald-500/30 rounded-lg px-2.5 py-1.5 flex items-center justify-between">
              <span class="eco-status-success text-emerald-700 dark:text-emerald-300 font-semibold">Completed</span>
              <span class="font-bold font-mono text-emerald-600 dark:text-emerald-400">${completedTasks}</span>
            </div>
            <div class="bg-cyan-50 dark:bg-slate-950/80 border border-cyan-500/30 rounded-lg px-2.5 py-1.5 flex items-center justify-between">
              <span class="eco-status-info text-cyan-700 dark:text-cyan-300 font-semibold">In Progress</span>
              <span class="font-bold font-mono text-cyan-600 dark:text-cyan-400">${inProgressTasks}</span>
            </div>
            <div class="bg-gray-100 dark:bg-slate-950/80 border border-gray-300 dark:border-slate-700 rounded-lg px-2.5 py-1.5 flex items-center justify-between">
              <span class="text-gray-600 dark:text-slate-400 font-semibold">Not Started</span>
              <span class="font-bold font-mono text-gray-600 dark:text-slate-400">${notStartedTasks}</span>
            </div>
            ${!isRepReport ? `
            <div class="${needsRepairTasks > 0 ? 'bg-rose-50 dark:bg-slate-950/80 border border-rose-500/30' : 'bg-gray-100 dark:bg-slate-950/80 border border-gray-300 dark:border-slate-700'} rounded-lg px-2.5 py-1.5 flex items-center justify-between">
              <span class="eco-status-danger ${needsRepairTasks > 0 ? 'text-rose-700 dark:text-rose-400' : 'text-gray-600 dark:text-slate-400'} font-semibold">Needs Repair</span>
              <span class="font-bold font-mono ${needsRepairTasks > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-gray-600 dark:text-slate-400'}">${needsRepairTasks}</span>
            </div>
            ` : ''}
          </div>
        </div>

        <!-- CONDITIONAL: REPAIR STATUS / DEFECT BANNER -->
        ${isRepairDone ? `
          <div class="bg-emerald-50/90 dark:bg-emerald-950/30 border-2 border-emerald-500/60 dark:border-emerald-400/60 rounded-2xl p-4 shadow-sm transition-all">
            <div class="flex items-center justify-between mb-2">
              <div class="flex items-center gap-2 text-emerald-800 dark:text-emerald-300 font-black text-xs uppercase tracking-wider">
                <span class="w-5 h-5 rounded-full bg-emerald-500 text-slate-950 flex items-center justify-center font-bold text-xs shadow-xs">✓</span>
                <span>Corrective Repair Completed • Already Repaired</span>
              </div>
              <div class="flex items-center gap-1.5">
                <span class="px-2.5 py-0.5 text-[10px] font-mono font-bold rounded-full bg-emerald-100 dark:bg-emerald-900/60 text-emerald-800 dark:text-emerald-200 border border-emerald-400/50">
                  ${childRepairs.length > 1 ? `All ${childRepairs.length} Repairs Done` : `Repair Task: ${repairReport?.id || ''}`}
                </span>
                ${isRepairVerified ? `
                  <span class="px-2 py-0.5 text-[10px] font-bold rounded-full bg-emerald-600 text-white shadow-xs">
                    Completed
                  </span>
                ` : ''}
              </div>
            </div>
            <div class="bg-white/95 dark:bg-slate-950/80 border border-emerald-300 dark:border-emerald-500/40 rounded-xl p-3 text-xs mb-3 shadow-sm">
              <div class="flex items-center justify-between mb-1.5">
                <span class="font-black text-gray-800 dark:text-white text-sm flex items-center gap-1.5">
                  <span class="w-2 h-2 rounded-full bg-emerald-500"></span>
                  ${repairComponentName}
                </span>
                <span class="px-2.5 py-0.5 text-[10px] font-black rounded-full bg-emerald-100 dark:bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 border border-emerald-400/50 uppercase tracking-wide">
                  ALREADY REPAIRED ✓
                </span>
              </div>
              <p class="text-gray-600 dark:text-gray-300 font-medium leading-relaxed">
                All defect repairs have been successfully completed and resolved${childRepairs.length > 1 ? ` (${childRepairs.map(c => c.id).join(', ')})` : (repairReport ? ` via corrective repair task <strong class="text-emerald-700 dark:text-emerald-300 font-mono">${repairReport.id}</strong>` : '')}.
                ${repairReport?.verificationRemarks ? `Remarks: "${repairReport.verificationRemarks}"` : (isRepairVerified ? 'Technician completed repairs and task has been verified.' : 'Technician completed repairs. Ready for administrator sign-off.')}
              </p>
              <div class="flex items-center justify-between text-[11px] text-gray-500 dark:text-gray-400 mt-2 pt-1.5 border-t border-gray-100 dark:border-white/5">
                <span>📍 Unit: <strong class="text-gray-800 dark:text-white">${report.airconId}</strong> (${report.room || 'Room'})</span>
                <span>Assigned Staff: <strong class="text-gray-700 dark:text-gray-300">${repairReport?.staffName || report.staffName || 'Technician'}</strong></span>
              </div>
            </div>
            <div class="flex items-center justify-between flex-wrap gap-2 pt-0.5">
              ${repairReport ? `
                <button type="button" class="btn-detail-view-repair px-3.5 py-1.5 bg-white dark:bg-slate-900 hover:bg-emerald-50 dark:hover:bg-slate-800 text-emerald-800 dark:text-emerald-300 font-bold text-xs rounded-xl border border-emerald-500/40 cursor-pointer shadow-xs transition-all flex items-center gap-1.5" data-repair-id="${repairReport.id}">
                  <svg class="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
                  <span>View Repair Task ${repairReport.id}</span>
                </button>
              ` : '<span></span>'}
              <div class="flex items-center gap-2">
                <button type="button" class="eco-primary-action btn-verify-repaired-task px-4 py-2 ${matchedRepairedTask?.verified ? 'bg-emerald-600 text-white' : 'bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950'} font-black text-xs rounded-xl border-0 cursor-pointer uppercase tracking-wider shadow-md hover:shadow-lg transition-all flex items-center gap-1.5" data-report-id="${report.id}" data-task-name="${encodeURIComponent(repairComponentName)}">
                  <svg class="w-4 h-4 ${matchedRepairedTask?.verified ? 'text-white' : 'text-slate-950'}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>
                  <span>${matchedRepairedTask?.verified ? 'Repaired & Verified' : 'Verify Repair'}</span>
                </button>
              </div>
            </div>
          </div>
        ` : (activeChildRepairs.length > 0 ? `
          <div class="bg-cyan-50/90 dark:bg-cyan-950/30 border-2 border-cyan-500/60 dark:border-cyan-400/60 rounded-2xl p-4 shadow-sm transition-all">
            <div class="flex items-center justify-between mb-2">
              <div class="flex items-center gap-2 text-cyan-800 dark:text-cyan-300 font-black text-xs uppercase tracking-wider">
                <span class="w-5 h-5 rounded-full bg-cyan-500 text-slate-950 flex items-center justify-center font-bold text-xs shadow-xs animate-pulse">⚙</span>
                <span>Corrective Repair In Progress • ${completedChildRepairs.length} of ${childRepairs.length} Repaired</span>
              </div>
              <div class="flex items-center gap-1.5">
                <span class="px-2.5 py-0.5 text-[10px] font-mono font-bold rounded-full bg-cyan-100 dark:bg-cyan-900/60 text-cyan-800 dark:text-cyan-200 border border-cyan-400/50">
                  ${activeChildRepairs.length} Active Repair${activeChildRepairs.length > 1 ? 's' : ''}
                </span>
              </div>
            </div>
            <div class="bg-white/95 dark:bg-slate-950/80 border border-cyan-300 dark:border-cyan-500/40 rounded-xl p-3 text-xs mb-3 shadow-sm">
              <p class="text-gray-600 dark:text-gray-300 font-medium leading-relaxed">
                Technician is currently performing corrective repairs on this aircon unit.
                ${completedChildRepairs.length > 0 ? ` Completed repair(s): <strong class="text-emerald-700 dark:text-emerald-300 font-mono">${completedChildRepairs.map(c => c.id).join(', ')}</strong>.` : ''}
                Active in-progress repair(s): <strong class="text-cyan-700 dark:text-cyan-300 font-mono">${activeChildRepairs.map(c => c.id).join(', ')}</strong>.
              </p>
              <div class="flex items-center justify-between text-[11px] text-gray-500 dark:text-gray-400 mt-2 pt-1.5 border-t border-gray-100 dark:border-white/5">
                <span>📍 Unit: <strong class="text-gray-800 dark:text-white">${report.airconId}</strong> (${report.room || 'Room'})</span>
                <span>Active Repairs: <strong class="text-gray-700 dark:text-gray-300">${activeChildRepairs.map(c => c.parentTaskName || c.issue?.component || c.id).join(', ')}</strong></span>
              </div>
            </div>
            <div class="flex items-center gap-2 flex-wrap pt-0.5">
              ${activeChildRepairs.map(cr => `
                <button type="button" class="btn-detail-view-repair px-3 py-1.5 bg-white dark:bg-slate-900 hover:bg-cyan-50 dark:hover:bg-slate-800 text-cyan-800 dark:text-cyan-300 font-bold text-xs rounded-xl border border-cyan-500/40 cursor-pointer shadow-xs transition-all flex items-center gap-1.5" data-repair-id="${cr.id}">
                  <span>View ${cr.id} (${cr.parentTaskName || cr.issue?.component || 'Repair'})</span>
                  <svg class="w-3.5 h-3.5 text-cyan-600 dark:text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
                </button>
              `).join('')}
            </div>
          </div>
        ` : '')}

        <!-- CHECKLIST TASKS -->
        <div class="bg-white dark:bg-slate-900/70 border border-gray-200 dark:border-white/10 rounded-2xl p-4 shadow-sm">
          <div class="flex items-center justify-between mb-2.5">
            <div>
              <h4 class="text-xs font-bold text-[#18392B] dark:text-cyan-300 uppercase tracking-wider">Checklist Status & Notes</h4>
              <span class="text-[10px] text-gray-500 dark:text-gray-400">Click item to view details & verify</span>
            </div>
            <span class="text-[10px] font-mono ${hasNeedsRepair ? 'text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-500/20' : (underRepairTasks > 0 ? 'text-cyan-600 dark:text-cyan-400 bg-cyan-50 dark:bg-cyan-950/40 border border-cyan-500/20' : 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-500/20')} px-2 py-0.5 rounded-full">
              ${completedTasks}/${totalTasks} Done${!isRepReport && needsRepairTasks > 0 ? ` • ${needsRepairTasks} Repair Needed` : ''}${!isRepReport && underRepairTasks > 0 ? ` • ${underRepairTasks} Under Repair` : ''}
            </span>
          </div>
          <div class="space-y-2 max-h-[220px] overflow-y-auto pr-1.5 eco-slim-scrollbar" id="detailModalChecklistContainer">
            ${report.tasks.map((task, idx) => {
          const tChildRepair = getRepairReportForTask(report, task, reports);
          const taskLinkedId = task.linkedRepairId || (tChildRepair && tChildRepair.id) || null;
          const isChildActive = Boolean(tChildRepair && !isRepairReportDone(tChildRepair));

          let isTaskRepairDone = false;
          let isTaskRepairVerified = false;
          if (tChildRepair) {
            if (isRepairReportVerified(tChildRepair)) {
              isTaskRepairDone = true;
              isTaskRepairVerified = true;
            } else if (isRepairReportDone(tChildRepair)) {
              isTaskRepairDone = true;
              isTaskRepairVerified = false;
            } else {
              isTaskRepairDone = false;
              isTaskRepairVerified = false;
              task.status = 'Under Repair';
              task.repaired = false;
              task.verified = false;
            }
          } else {
            isTaskRepairDone = Boolean(task.repaired);
            isTaskRepairVerified = Boolean(task.repaired && task.verified);
          }

          let badge = `<span class="inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-bold rounded-full bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-gray-400 border border-gray-300 dark:border-slate-700 shrink-0 select-none pointer-events-none">⚪ Not Started</span>`;
          if (isChildActive || (task.status === 'Under Repair' && taskLinkedId)) {
            badge = `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 text-[10px] font-bold rounded-full bg-cyan-100 dark:bg-cyan-500/20 text-cyan-800 dark:text-cyan-300 border border-cyan-400/40 shrink-0 select-none pointer-events-none"><span>🔵 Under Repair</span>${taskLinkedId ? `<span class="text-[9px] font-mono opacity-80">(${taskLinkedId})</span>` : ''}</span>`;
          } else if (isTaskRepairVerified) {
            badge = `<span class="inline-flex items-center gap-1 px-2.5 py-0.5 text-[10px] font-bold rounded-full bg-emerald-100 dark:bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 border border-emerald-400/40 shrink-0 select-none pointer-events-none"><span>🟢 Repaired</span>${taskLinkedId ? `<span class="text-[9px] font-mono opacity-80">(${taskLinkedId})</span>` : ''}</span>`;
          } else if (isTaskRepairDone) {
            badge = `<span class="inline-flex items-center gap-1 px-2.5 py-0.5 text-[10px] font-bold rounded-full bg-amber-100 dark:bg-amber-500/20 text-amber-800 dark:text-amber-300 border border-amber-400/40 shrink-0 select-none pointer-events-none"><span>🟡 Repaired (Pending Sign-off)</span>${taskLinkedId ? `<span class="text-[9px] font-mono opacity-80">(${taskLinkedId})</span>` : ''}</span>`;
          } else if (task.status === 'Completed') {
            badge = `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 text-[10px] font-bold rounded-full bg-emerald-100 dark:bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 border border-emerald-400/40 shrink-0 select-none pointer-events-none">🟢 Completed</span>`;
          } else if (task.status === 'In Progress') {
            badge = `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 text-[10px] font-bold rounded-full bg-cyan-100 dark:bg-cyan-500/20 text-cyan-800 dark:text-cyan-300 border border-cyan-400/40 shrink-0 select-none pointer-events-none">🟠 In Progress</span>`;
          } else if (task.status === 'Needs Repair') {
            badge = !isRepReport
              ? `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 text-[10px] font-bold rounded-full bg-rose-100 dark:bg-rose-500/20 text-rose-800 dark:text-rose-300 border border-rose-400/40 shrink-0 select-none pointer-events-none">🔴 Needs Repair</span>`
              : `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 text-[10px] font-bold rounded-full bg-cyan-100 dark:bg-cyan-500/20 text-cyan-800 dark:text-cyan-300 border border-cyan-400/40 shrink-0 select-none pointer-events-none"><span>🔵 In Progress</span></span>`;
          }

          const isTaskActuallyDone = !isChildActive && (isTaskRepairVerified || isTaskRepairDone || task.status === 'Completed');
          const verifiedBadge = (!isChildActive && (isTaskRepairVerified || (task.verified && task.status === 'Completed'))) ? `
            <span class="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>
              Verified
            </span>
          ` : '';

          const taskPhotoCount = (Array.isArray(task.photoUris) && task.photoUris.length) ||
            (Array.isArray(task.photos) && task.photos.length) ||
            (task.photo || task.photoUri ? 1 : 0);
          const hasTaskPhoto = task.status !== 'Not Started' && taskPhotoCount > 0;

          const photoBadge = hasTaskPhoto ? `
            <span class="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold rounded-full bg-sky-500/15 text-sky-600 dark:text-sky-400 border border-sky-500/30">
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/><circle cx="12" cy="13" r="3"/></svg>
              ${taskPhotoCount > 1 ? `${taskPhotoCount} Photos` : 'Photo'}
            </span>
          ` : '';

          const canQuickVerify = !isRepReport && !isChildActive && isTaskRepairDone && !isTaskRepairVerified;

          return `
                <div class="checklist-task-item group bg-gray-50 dark:bg-slate-950/70 hover:bg-emerald-50/50 dark:hover:bg-slate-800/80 border border-gray-200 dark:border-white/10 hover:border-emerald-500/40 rounded-xl p-2.5 flex items-center justify-between gap-2 text-xs shadow-sm cursor-pointer transition-all" data-task-id="${task.id}" data-task-name="${encodeURIComponent(task.name)}" title="Click to view details & verify">
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center flex-wrap gap-2 mb-0.5">
                      <span class="checklist-step-badge w-5 h-5 rounded-md ${isTaskActuallyDone ? 'badge-emerald bg-emerald-500 text-white' : (isChildActive || task.status === 'Under Repair' ? 'badge-cyan bg-cyan-600 text-white' : (task.status === 'Needs Repair' ? 'badge-rose bg-rose-600 text-white' : (task.status === 'In Progress' ? 'badge-cyan bg-cyan-600 text-white' : 'bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200')))} font-black text-[10px] flex items-center justify-center shrink-0 shadow-xs mr-1">${idx + 1}</span>
                      <span class="font-bold text-gray-800 dark:text-white group-hover:text-emerald-700 dark:group-hover:text-emerald-300 transition-colors">${task.name}</span>
                      ${badge}
                      ${verifiedBadge}
                      ${photoBadge}
                    </div>
                    <p class="text-[11px] ${!isRepReport && task.status === 'Needs Repair' ? 'text-rose-600 dark:text-rose-400 font-medium' : 'text-gray-500 dark:text-gray-400'} truncate">${task.notes && task.notes.trim() ? `"${task.notes.trim()}"` : (!isRepReport && task.status === 'Needs Repair' ? '"Defect reported."' : 'No worker notes.')}</p>
                  </div>
                  <div class="flex items-center gap-2 shrink-0">
                    ${canQuickVerify ? `
                      <button type="button" class="btn-quick-verify-task px-2.5 py-1 text-[10px] font-extrabold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white shadow-xs flex items-center gap-1 cursor-pointer transition-all z-10" data-task-id="${task.id}" data-task-name="${encodeURIComponent(task.name)}" title="Verify completed repair for ${task.name}">
                        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>
                        <span>Verify</span>
                      </button>
                    ` : ''}
                    ${taskLinkedId ? `
                      <button type="button" class="btn-view-task-repair px-2 py-1 text-[10px] font-bold rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-700 dark:text-cyan-300 border border-cyan-500/30 flex items-center gap-1 cursor-pointer transition-all z-10" data-repair-id="${taskLinkedId}" title="View repair task ${taskLinkedId}">
                        <span>${taskLinkedId}</span>
                        <svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
                      </button>
                    ` : ''}
                    <span class="text-[10px] font-mono text-gray-400">${task.updated || 'Today'}</span>
                    <svg class="w-4 h-4 text-gray-400 group-hover:text-emerald-500 group-hover:translate-x-0.5 transition-all" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
                  </div>
                </div>
              `;
        }).join('')}
          </div>

          <!-- CONDITIONAL: VERIFICATION (AT THE BOTTOM OF THE CHECKLIST STATUS NOTE CONTAINER) -->
          ${isReadyForVerification ? `
            <div class="mt-4 pt-3.5 border-t border-gray-100 dark:border-white/10">
              <div class="bg-amber-50/80 dark:bg-amber-950/30 border-2 border-amber-500/60 dark:border-amber-400/50 rounded-2xl p-4 shadow-sm">
                <div class="flex items-center justify-between mb-2">
                  <div class="flex items-center gap-2">
                    <span class="w-2.5 h-2.5 rounded-full bg-amber-500 animate-ping"></span>
                    <span class="text-xs font-black text-amber-800 dark:text-amber-300 uppercase tracking-wider">
                      Completed — Awaiting Admin Verification
                    </span>
                  </div>
                  <span class="font-mono text-xs font-bold text-amber-900 dark:text-amber-200 bg-amber-200/60 dark:bg-amber-900/60 px-2.5 py-0.5 rounded-full border border-amber-400/40">
                    ${completedTasks}/${totalTasks} Tasks Done
                  </span>
                </div>
                <p class="text-xs text-amber-950/80 dark:text-amber-200/90 font-medium mb-3 bg-white/80 dark:bg-slate-950/70 p-3 rounded-xl border border-amber-400/30 leading-relaxed">
                  Technician has completed all checklist tasks. Administrator review and verification is required to finalize this maintenance report.
                </p>
                <div class="flex items-center justify-between gap-2 flex-wrap pt-1">
                  <div class="text-[11px] text-gray-500 dark:text-gray-400 italic">
                    Action required: Review checklist findings and sign off.
                  </div>
                  <div class="flex items-center gap-2">
                    
                    <button type="button" class="eco-primary-action btn-detail-verify px-5 py-2 bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-black text-xs rounded-xl border-0 cursor-pointer uppercase tracking-wider shadow-md hover:shadow-lg transition-all flex items-center gap-1.5" data-id="${report.id}">
                      <svg class="w-4 h-4 text-slate-950" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>
                      <span>Verify Maintenance</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ` : (isVerified ? `
            <div class="mt-4 pt-3.5 border-t border-gray-100 dark:border-white/10">
              <div class="bg-emerald-50/80 dark:bg-emerald-950/30 border-2 border-emerald-500/60 dark:border-emerald-400/60 rounded-2xl p-4 shadow-sm">
                <div class="flex items-center justify-between mb-2">
                  <div class="flex items-center gap-2">
                    <span class="w-6 h-6 rounded-full bg-emerald-500 text-slate-950 flex items-center justify-center font-bold text-xs shadow-sm">✓</span>
                    <div>
                      <span class="text-xs font-black text-emerald-800 dark:text-emerald-300 uppercase tracking-wider block">
                        Maintenance Verified & Approved by Admin
                      </span>
                      <span class="text-[10px] text-emerald-600 dark:text-emerald-400">All ${totalTasks} checklist items inspected & verified</span>
                    </div>
                  </div>
                  <span class="font-mono text-[11px] font-bold text-emerald-800 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-900/60 px-3 py-1 rounded-full border border-emerald-400/50 flex items-center gap-1">
                    <span>Verified</span> ✓
                  </span>
                </div>
                <div class="bg-white/80 dark:bg-slate-950/70 p-3 rounded-xl border border-emerald-500/30 text-xs text-gray-700 dark:text-gray-200">
                  <p class="font-medium text-emerald-900 dark:text-emerald-200 italic mb-1">
                    "${report.verificationRemarks || 'Maintenance verified and officially approved by Administrator. Unit is operational and cleared.'}"
                  </p>
                  <div class="flex items-center justify-between text-[10px] text-gray-400 pt-1 border-t border-gray-100 dark:border-white/5">
                    <span>Status: <strong>Finalized</strong></span>
                    <span>Verified by Admin</span>
                  </div>
                </div>
              </div>
            </div>
          ` : '')}
        </div>

        <!-- TIMELINE & HISTORY -->
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div class="bg-white dark:bg-slate-900/70 border border-gray-200 dark:border-white/10 rounded-xl p-3 shadow-sm flex flex-col">
            <div class="flex items-center justify-between mb-2">
              <h5 class="text-[11px] font-bold text-[#18392B] dark:text-cyan-300 uppercase">Activity Timeline</h5>
              ${report.timeline && report.timeline.length > 0 ? `<span class="text-[10px] text-gray-400 font-mono">${report.timeline.length} events</span>` : ''}
            </div>
            <div class="space-y-1.5 text-[11px] max-h-44 overflow-y-auto pr-1.5 eco-slim-scrollbar">
              ${report.timeline && report.timeline.length > 0 ? report.timeline.map(t => `
                <div class="flex items-center justify-between text-gray-700 dark:text-gray-300 py-0.5 hover:bg-gray-50 dark:hover:bg-slate-800/40 rounded px-1 -mx-1 transition-colors">
                  <span class="flex items-center gap-1.5 min-w-0 pr-2">
                    <span class="w-1.5 h-1.5 rounded-full shrink-0 ${t.done ? 'bg-emerald-500' : 'bg-gray-400 dark:bg-gray-600'}"></span>
                    <span class="truncate">${t.title}</span>
                  </span>
                  <span class="text-[10px] text-gray-400 font-mono shrink-0 whitespace-nowrap">${t.time}</span>
                </div>
              `).join('') : '<p class="text-gray-400 italic text-center py-2">No activity recorded yet.</p>'}
            </div>
          </div>

          <div class="bg-white dark:bg-slate-900/70 border border-gray-200 dark:border-white/10 rounded-xl p-3 shadow-sm flex flex-col">
            <h5 class="text-[11px] font-bold text-[#18392B] dark:text-cyan-300 uppercase mb-2">AC Unit Maintenance History</h5>
            <div class="space-y-1.5 text-[11px] max-h-44 overflow-y-auto pr-1.5 eco-slim-scrollbar">
              ${acHistory.length === 0 ? '<p class="text-gray-400 italic text-center py-2">No prior logs.</p>' : acHistory.map(h => `
                <div class="flex items-center justify-between text-gray-700 dark:text-gray-300 border-b border-gray-100 dark:border-white/5 pb-1 last:border-0 hover:bg-gray-50 dark:hover:bg-slate-800/40 rounded px-1 -mx-1 transition-colors">
                  <span class="truncate pr-2">${h.id} • ${h.type}</span>
                  <span class="text-[10px] text-emerald-600 dark:text-emerald-400 font-bold shrink-0">${h.status}</span>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      `;

      // Attach task row click to open item modal
      body.querySelectorAll('.checklist-task-item').forEach((item, idx) => {
        item.addEventListener('click', () => {
          const attrId = item.getAttribute('data-task-id');
          const attrName = decodeURIComponent(item.getAttribute('data-task-name') || '');
          const targetId = (attrId && attrId !== 'undefined' && attrId !== 'NaN') ? attrId : (attrName || (idx + 1));
          openChecklistItemModal(report.id, targetId);
        });
      });

      body.querySelectorAll('.btn-view-task-repair').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const repId = btn.getAttribute('data-repair-id');
          if (repId) openDetailModal(repId);
        });
      });

      body.querySelectorAll('.btn-quick-verify-task').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const tId = btn.getAttribute('data-task-id');
          const tName = decodeURIComponent(btn.getAttribute('data-task-name') || '');
          const targetTask = report.tasks ? report.tasks.find(t => (tId && String(t.id) === String(tId)) || (tName && String(t.name).toLowerCase().trim() === tName.toLowerCase().trim())) : null;
          if (targetTask) {
            targetTask.status = 'Completed';
            targetTask.repaired = true;
            targetTask.verified = true;
            targetTask.verifiedAt = new Date().toISOString();
            targetTask.updated = 'Just now';
          }
          const tRep = targetTask ? getRepairReportForTask(report, targetTask, reports) : null;
          if (tRep) {
            tRep.status = 'Completed';
            tRep.verified = true;
            if (Array.isArray(tRep.tasks)) {
              tRep.tasks.forEach(rt => {
                rt.status = 'Completed';
                rt.verified = true;
                if (!rt.verifiedAt) rt.verifiedAt = new Date().toISOString();
              });
            }
            if (!tRep.timeline) tRep.timeline = [];
            tRep.timeline.unshift({
              title: `Repair ${tRep.id} verified & signed off by Admin`,
              time: 'Just now',
              done: true,
              by: 'Admin'
            });
            await saveReports(reports, tRep);
          }
          const remNeedsRepair = report.tasks.some(t => t.status === 'Needs Repair' && !t.repaired);
          const remUnderRepair = report.tasks.some(t => {
            const cr = getRepairReportForTask(report, t, reports);
            if (cr && !isRepairReportDone(cr)) return true;
            return t.status === 'Under Repair' && !t.repaired;
          });
          const allParentDone = report.tasks.length > 0 && report.tasks.every(t => {
            const cr = getRepairReportForTask(report, t, reports);
            if (cr && !isRepairReportDone(cr)) return false;
            return t.status === 'Completed' || t.repaired;
          });
          const allParentVerified = allParentDone && report.tasks.every(t => t.verified);
          if (remNeedsRepair) {
            report.status = 'Needs Repair';
            report.verified = false;
            if (report.issue) {
              report.issue.repaired = false;
              report.issue.status = 'Needs Repair';
            }
          } else if (remUnderRepair) {
            report.status = 'Under Repair';
            report.verified = false;
            if (report.issue) {
              report.issue.repaired = false;
              report.issue.status = 'Under Repair';
            }
          } else if (allParentVerified) {
            report.status = 'Completed';
            report.verified = true;
            if (report.issue) {
              report.issue.repaired = true;
              report.issue.status = 'Repaired';
            }
          } else if (allParentDone) {
            report.status = 'For Verification';
            if (report.issue) {
              report.issue.repaired = true;
              report.issue.status = 'Repaired';
            }
          }
          if (!report.timeline) report.timeline = [];
          report.timeline.unshift({
            title: `Repaired defect "${targetTask ? targetTask.name : (tName || 'Item')}" verified by Admin`,
            time: 'Just now',
            done: true,
            by: 'Admin'
          });
          await saveReports(reports, report);
          renderDetailModalContent();
          refreshPageReportsView();
          window.dispatchEvent(new Event('storage'));
          window.dispatchEvent(new CustomEvent('ecotrack:reports-updated', { detail: _reportsCache }));
          broadcastMaintenanceChange('REPAIR_VERIFIED');
          showToast('Task Verified', `Repaired task "${targetTask ? targetTask.name : (tName || 'Item')}" verified by Admin!`, 'success');
        });
      });

      body.querySelector('.btn-detail-verify')?.addEventListener('click', async () => {
        const unresolvedTasks = report.tasks ? report.tasks.filter(t => (t.status === 'Needs Repair' || t.status === 'Under Repair') && !t.repaired) : [];
        const activeChildRepairs = getChildRepairReportsFor(report, reports).filter(cr => !isRepairReportDone(cr));
        if (unresolvedTasks.length > 0 || activeChildRepairs.length > 0 || (report.issue && !report.issue.repaired)) {
          showToast('Cannot Verify', activeChildRepairs.length > 0 ? `Please complete all repair tasks first (${activeChildRepairs.map(c => c.id).join(', ')} still in progress).` : 'Please resolve all repair issues before verifying.', 'error');
          return;
        }
        report.status = 'Completed';
        report.verified = true;
        if (Array.isArray(report.tasks)) {
          report.tasks.forEach(t => {
            if (t.status === 'Completed') {
              t.verified = true;
              t.verifiedAt = new Date().toISOString();
            }
          });
        }
        if (!report.timeline) report.timeline = [];
        report.timeline.unshift({
          title: 'Maintenance report verified and approved by Admin',
          time: 'Just now',
          done: true,
          by: 'Admin'
        });
        if (!report.verificationRemarks) {
          report.verificationRemarks = 'Inspected, tested, and officially approved by Administrator.';
        }

        try { await saveReports(reports, report); }
        catch { return; }

        // If this report is a child repair task, update ONLY the specific parent task!
        const parentId = report.parentReportId || report.linkedParentId;
        let parentRep = parentId ? findReportById(reports, parentId) : null;
        if (!parentRep && report.parentReportId) {
          parentRep = reports.find(pr => pr && pr.id === report.parentReportId);
        }
        if (parentRep) {
          let targetParentTask = null;
          if (Array.isArray(parentRep.tasks)) {
            targetParentTask = parentRep.tasks.find(pt => pt.linkedRepairId && String(pt.linkedRepairId).trim().toLowerCase() === String(report.id).trim().toLowerCase());
            if (!targetParentTask && report.parentTaskId !== undefined && report.parentTaskId !== null) {
              targetParentTask = parentRep.tasks.find(pt => String(pt.id) === String(report.parentTaskId));
            }
            if (!targetParentTask && report.parentTaskName) {
              targetParentTask = parentRep.tasks.find(pt => String(pt.name).trim().toLowerCase() === String(report.parentTaskName).trim().toLowerCase());
            }
            if (!targetParentTask && report.issue?.component) {
              const comp = String(report.issue.component).trim().toLowerCase();
              targetParentTask = parentRep.tasks.find(pt => String(pt.name || '').trim().toLowerCase() === comp);
            }
          }

          if (targetParentTask) {
            targetParentTask.status = 'Completed';
            targetParentTask.repaired = true;
            targetParentTask.verified = true;
            targetParentTask.linkedRepairId = report.id;
            if (!targetParentTask.verifiedAt) targetParentTask.verifiedAt = new Date().toISOString();
          }

          // Recalculate parent report status based on ALL parent tasks
          const hasRemainingNeedsRepair = Array.isArray(parentRep.tasks) && parentRep.tasks.some(pt => pt.status === 'Needs Repair' && !pt.repaired);
          const hasRemainingUnderRepair = Array.isArray(parentRep.tasks) && parentRep.tasks.some(pt => {
            const cr = getRepairReportForTask(parentRep, pt, reports);
            if (cr && String(cr.id).toLowerCase() !== String(report.id).toLowerCase() && !isRepairReportDone(cr)) return true;
            return pt.status === 'Under Repair' && !pt.repaired;
          });
          const allParentDone = Array.isArray(parentRep.tasks) && parentRep.tasks.length > 0 && parentRep.tasks.every(pt => {
            const cr = getRepairReportForTask(parentRep, pt, reports);
            if (cr && String(cr.id).toLowerCase() !== String(report.id).toLowerCase() && !isRepairReportDone(cr)) return false;
            return pt.status === 'Completed' || pt.repaired;
          });
          const allParentVerified = allParentDone && parentRep.tasks.every(pt => pt.verified);

          if (hasRemainingNeedsRepair) {
            parentRep.status = 'Needs Repair';
            parentRep.verified = false;
          } else if (hasRemainingUnderRepair) {
            parentRep.status = 'Under Repair';
            parentRep.verified = false;
          } else if (allParentVerified) {
            parentRep.status = 'Completed';
            parentRep.verified = true;
            if (parentRep.issue) {
              parentRep.issue.repaired = true;
              parentRep.issue.status = 'Repaired';
            }
          } else if (allParentDone) {
            parentRep.status = 'For Verification';
            if (parentRep.issue) {
              parentRep.issue.repaired = true;
              parentRep.issue.status = 'Repaired';
            }
          }

          if (!parentRep.timeline) parentRep.timeline = [];
          parentRep.timeline.unshift({
            title: `Corrective repair ${report.id} (${targetParentTask ? targetParentTask.name : 'Defect'}) completed and verified by Admin`,
            time: 'Just now',
            done: true,
            by: 'Admin'
          });

          try { await saveReports(reports, parentRep); }
          catch { return; }
        }

        renderDetailModalContent();
        refreshPageReportsView();
        window.dispatchEvent(new Event('storage'));
        window.dispatchEvent(new CustomEvent('ecotrack:reports-updated', { detail: _reportsCache }));
        broadcastMaintenanceChange('MAINTENANCE_VERIFIED');
        showToast('Maintenance Verified', `Maintenance Report ${report.id} verified and approved by Admin!`, 'success');
      });

      body.querySelectorAll('.btn-detail-view-repair').forEach(btn => {
        btn.addEventListener('click', () => {
          const repId = btn.getAttribute('data-repair-id');
          if (repId) openDetailModal(repId);
        });
      });

      body.querySelectorAll('.btn-verify-repaired-task').forEach(btn => {
        btn.addEventListener('click', async () => {
          const taskName = decodeURIComponent(btn.getAttribute('data-task-name') || '').toLowerCase().trim();
          const specificTaskId = btn.getAttribute('data-task-id');

          // Find ONLY the target task
          let targetTask = null;
          if (Array.isArray(report.tasks)) {
            if (specificTaskId) {
              targetTask = report.tasks.find(t => String(t.id) === String(specificTaskId));
            }
            if (!targetTask && taskName) {
              targetTask = report.tasks.find(t => String(t.name || '').toLowerCase().trim() === taskName);
            }
            if (!targetTask) {
              targetTask = report.tasks.find(t => t.repaired && !t.verified);
            }
          }

          if (targetTask) {
            targetTask.status = 'Completed';
            targetTask.repaired = true;
            targetTask.verified = true;
            targetTask.verifiedAt = new Date().toISOString();
            targetTask.updated = 'Just now';
          }

          const targetRepair = targetTask ? getRepairReportForTask(report, targetTask, reports) : (repairReport || null);
          if (targetRepair) {
            targetRepair.status = 'Completed';
            targetRepair.verified = true;
            if (Array.isArray(targetRepair.tasks)) {
              targetRepair.tasks.forEach(rt => {
                rt.status = 'Completed';
                rt.verified = true;
                if (!rt.verifiedAt) rt.verifiedAt = new Date().toISOString();
              });
            }
            if (!targetRepair.timeline) targetRepair.timeline = [];
            targetRepair.timeline.unshift({
              title: `Repair ${targetRepair.id} verified & signed off by Admin`,
              time: 'Just now',
              done: true,
              by: 'Admin'
            });
            await saveReports(reports, targetRepair);
          }

          // Recalculate parent report status based on ALL tasks
          const hasRemainingNeedsRepair = Array.isArray(report.tasks) && report.tasks.some(pt => pt.status === 'Needs Repair' && !pt.repaired);
          const hasRemainingUnderRepair = Array.isArray(report.tasks) && report.tasks.some(pt => {
            const cr = getRepairReportForTask(report, pt, reports);
            if (cr && !isRepairReportDone(cr)) return true;
            return pt.status === 'Under Repair' && !pt.repaired;
          });
          const allParentDone = Array.isArray(report.tasks) && report.tasks.length > 0 && report.tasks.every(pt => {
            const cr = getRepairReportForTask(report, pt, reports);
            if (cr && !isRepairReportDone(cr)) return false;
            return pt.status === 'Completed' || pt.repaired;
          });
          const allParentVerified = allParentDone && report.tasks.every(pt => pt.verified);

          if (hasRemainingNeedsRepair) {
            report.status = 'Needs Repair';
            report.verified = false;
          } else if (hasRemainingUnderRepair) {
            report.status = 'Under Repair';
            report.verified = false;
          } else if (allParentVerified) {
            report.status = 'Completed';
            report.verified = true;
            report.verified = true;
            if (report.issue) {
              report.issue.repaired = true;
              report.issue.status = 'Repaired';
            }
          } else if (allParentDone) {
            report.status = 'For Verification';
            if (report.issue) {
              report.issue.repaired = true;
              report.issue.status = 'Repaired';
            }
          }

          if (!report.timeline) report.timeline = [];
          report.timeline.unshift({
            title: `Repaired defect "${targetTask ? targetTask.name : (taskName || 'Defect')}" verified by Admin`,
            time: 'Just now',
            done: true,
            by: 'Admin'
          });

          await saveReports(reports, report);
          renderDetailModalContent();
          refreshPageReportsView();
          window.dispatchEvent(new Event('storage'));
          window.dispatchEvent(new CustomEvent('ecotrack:reports-updated', { detail: _reportsCache }));
          broadcastMaintenanceChange('REPAIR_VERIFIED');
          showToast('Repair Verified', `Repaired defect "${targetTask ? targetTask.name : (taskName || 'Defect')}" verified!`, 'success');
        });
      });



      body.querySelectorAll('.btn-detail-repair').forEach(btn => {
        btn.addEventListener('click', () => {
          openRepairTaskModal(report.id);
        });
      });
    }
  }

  // Toast helper
  function showToast(title, message, type = 'info') {
    let toastContainer = document.getElementById('ecoToastContainer');
    if (!toastContainer) {
      toastContainer = document.createElement('div');
      toastContainer.id = 'ecoToastContainer';
      toastContainer.className = 'fixed bottom-5 right-5 z-[999999] flex flex-col gap-2 pointer-events-none';
      toastContainer.style.zIndex = '999999';
      document.body.appendChild(toastContainer);
    } else {
      toastContainer.style.zIndex = '999999';
    }

    const toast = document.createElement('div');
    toast.className = 'pointer-events-auto bg-white dark:bg-[#0c1328] border-2 border-[#10b981] text-gray-800 dark:text-gray-100 rounded-2xl px-4 py-3 shadow-2xl flex items-center gap-3 transition-all duration-300 transform translate-y-2 opacity-0 max-w-sm';

    let iconSvg = '<span class="text-[#10b981] font-bold text-lg">✓</span>';
    if (type === 'warning') iconSvg = '<span class="text-amber-500 font-bold text-lg">⚠</span>';
    if (type === 'error') iconSvg = '<span class="text-rose-500 font-bold text-lg">✕</span>';

    toast.innerHTML = `
      ${iconSvg}
      <div class="flex-1">
        <div class="text-xs font-bold text-[#18392B] dark:text-cyan-300 uppercase tracking-wide">${title}</div>
        <div class="text-xs text-gray-600 dark:text-gray-300 mt-0.5">${message}</div>
      </div>
    `;

    toastContainer.appendChild(toast);
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        toast.classList.remove('translate-y-2', 'opacity-0');
      });
    } else {
      setTimeout(() => {
        toast.classList.remove('translate-y-2', 'opacity-0');
      }, 10);
    }

    setTimeout(() => {
      toast.classList.add('opacity-0', 'translate-x-4');
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  // Delete Multiple Reports
  async function deleteReports(reportIds) {
    const raw = reportIds && typeof reportIds === 'object' && !Array.isArray(reportIds)
      ? (reportIds.ids ?? reportIds.report_ids ?? reportIds.id) : reportIds;
    const entries = Array.isArray(raw) ? raw.flat(Infinity) : [raw];
    const ids = [...new Set(entries
      .filter(id => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id)))
      .map(id => String(id).trim()).filter(Boolean))];
    if (ids.length === 0) return false;

    // Include dependent repair reports, removing children before parents.
    const allReports = getReports();
    const idSet = new Set(ids);
    let added;
    do {
      added = false;
      allReports.forEach(r => {
        if (idSet.has(r.parent_report_id || r.parentReportId) && !idSet.has(r.id)) {
          idSet.add(r.id);
          ids.unshift(r.id);
          added = true;
        }
      });
    } while (added);

    await Promise.resolve(window?.ecotrackAuthReady).catch(() => {});
    const client = typeof getSb === 'function' ? getSb() : null;
    if (client?.auth && typeof client.auth.getSession === 'function') {
      try {
        const { data: sessionData } = await client.auth.getSession().catch(() => ({ data: { session: null } }));
        if (!sessionData?.session && typeof client.auth.refreshSession === 'function') {
          const { data: refreshed } = await client.auth.refreshSession().catch(() => ({ data: { session: null } }));
          if (refreshed?.session && window?.electron?.invoke) {
            await window.electron.invoke('auth-set-session', {
              access_token: refreshed.session.access_token,
              refresh_token: refreshed.session.refresh_token
            }).catch(() => {});
          }
        }
      } catch (_) {}
    }

    let deletedRows = null;
    let deletionError = null;
    try {
      if (window?.electron && typeof window.electron.invoke === 'function') {
        try {
          const result = await window.electron.invoke('maintenance-delete-reports', ids);
          if (result?.success && Array.isArray(result.data) && result.data.length) {
            deletedRows = result.data;
          } else if (result?.error && String(result.error).includes('No maintenance reports were deleted')) {
            // Target reports do not exist in the remote database (e.g. mock/test records, already removed, or uncommitted local drafts).
            // Confirm their deletion locally so the user is never trapped with undeletable ghost records.
            deletedRows = ids.map(id => ({ id }));
          } else {
            deletionError = new Error(result?.error || 'No reports were deleted');
          }
        } catch (error) { deletionError = error; }
      }
      if (!deletedRows) {
        const testIds = ids.filter(id => {
          const s = String(id || '').trim().toUpperCase();
          return s.includes('-TEST-') || s.startsWith('TEST-') || s.endsWith('-TEST') || s.includes('TEST_') || s.includes('MOCK');
        });
        if (testIds.length === ids.length) {
          deletedRows = ids.map(id => ({ id }));
        } else {
          if (!client) throw deletionError || new Error('Database service unavailable');
          try {
            const result = await client.rpc('delete_maintenance_reports', { report_ids: ids });
            if (!result.error && Array.isArray(result.data) && result.data.length) {
              deletedRows = result.data;
            }
          } catch (_) {}

          if (!deletedRows) {
            const { data: directData, error: directErr } = await client
              .from('maintenance_reports')
              .delete()
              .in('id', ids)
              .select('id');
            if (!directErr && Array.isArray(directData) && directData.length) {
              deletedRows = directData;
            } else if (directErr) {
              throw directErr;
            }
          }

          if (!deletedRows || !deletedRows.length) {
            throw deletionError || new Error('No reports were deleted. Check report IDs and database permissions.');
          }
        }
      }
      idSet.clear();
      deletedRows.forEach(r => idSet.add(String(r.id).trim()));
    } catch (error) {
      showToast('Deletion Failed', error.message, 'error');
      if (String(error?.message || '').toLowerCase().includes('sign in') && typeof window !== 'undefined' && window.location && !window.location.pathname.endsWith('login.html')) {
        setTimeout(() => {
          if (window.location && !window.location.pathname.endsWith('login.html')) {
            window.location.href = 'login.html';
          }
        }, 2000);
      }
      return false;
    }
    const reports = getReports().filter(r => !idSet.has(r.id)).map(r => {
      if (idSet.has(r.linked_repair_id || r.linkedRepairId)) {
        r.linked_repair_id = null;
        r.linkedRepairId = null;
      }
      (r.tasks || []).forEach(task => {
        if (idSet.has(task.linkedRepairId)) task.linkedRepairId = null;
      });
      return r;
    });
    _reportsCache = reports;
    try {
      localStorage.setItem('ecoTrack_maintenance_reports', JSON.stringify(reports));
      window.dispatchEvent(new Event('storage'));
      refreshPageReportsView();
      window.dispatchEvent(new CustomEvent('ecotrack:reports-updated', { detail: _reportsCache }));
      broadcastMaintenanceChange('REPORTS_DELETED');
    } catch (e) {
      console.error('Error deleting reports locally:', e);
    }

    const deletedIds = [...idSet];
    const msg = deletedIds.length === 1 ? `Report ${deletedIds[0]} was successfully deleted.` : `${deletedIds.length} maintenance reports were successfully deleted.`;
    showToast(deletedIds.length === 1 ? 'Report Deleted' : 'Reports Deleted', msg, 'warning');
    return ids.every(id => idSet.has(id));
  }

  // Delete Single Report
  async function deleteReport(reportId) {
    return deleteReports([reportId]);
  }

  // ===================================================================
  // 4. INITIALIZATION & EXPORTS
  // ===================================================================

  function init() {
    // Purge duplicate and mock/test reports from localStorage on startup
    try {
      const stored = localStorage.getItem('ecoTrack_maintenance_reports');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          const clean = deduplicateReports(parsed.map(normalizeReport).filter(r => r && !isMockOrTestReport(r)));
          localStorage.setItem('ecoTrack_maintenance_reports', JSON.stringify(clean));
        }
      }
    } catch (_) { }

    getReports();
    injectCreateModalHTML();
    injectDetailModalHTML();
    injectChecklistItemModalHTML();
    injectRepairTaskModalHTML();
    injectEditRepairTaskModalHTML();
    Promise.all([fetchReportsFromSupabase(), fetchStaffFromSupabase(), fetchAirconsFromSupabase()]).then(() => {
      if (!/staff\.html$/i.test(window.location.pathname)) return;
      const reportId = new URLSearchParams(window.location.search).get('verifyReport');
      if (!reportId) return;
      const report = findReportById(getReports(), reportId);
      if (!report) { showToast('Report Unavailable', `Report ${reportId} could not be loaded.`, 'error'); return; }
      openDetailModal(reportId);
    });
    setupMaintenanceRealtime();

    // If Supabase wasn't ready synchronously at script parse time, poll and retry
    if (!getSb()) {
      let attempts = 0;
      const pollSb = setInterval(() => {
        attempts++;
        if (getSb()) {
          clearInterval(pollSb);
          fetchReportsFromSupabase();
          fetchStaffFromSupabase();
          fetchAirconsFromSupabase();
          setupMaintenanceRealtime();
        } else if (attempts > 30) {
          clearInterval(pollSb);
        }
      }, 150);
    }
  }

  // Also listen for supabase:ready event
  window.addEventListener('supabase:ready', () => {
    fetchReportsFromSupabase();
    fetchStaffFromSupabase();
    fetchAirconsFromSupabase();
    setupMaintenanceRealtime();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Cycle individual task status
  function cycleTaskStatus(e, reportId, taskId) {
    if (e && e.stopPropagation) e.stopPropagation();
    const reports = getReports();
    let report = findReportById(reports, reportId) || findReportById(reports, currentDetailId) || reports[0];
    if (!report || !Array.isArray(report.tasks)) return;

    const numIdx = parseInt(taskId, 10);
    let task = report.tasks.find(t =>
      (t.id !== undefined && t.id !== null && (String(t.id) === String(taskId) || t.id == taskId)) ||
      (t.name && taskId && String(t.name).trim().toLowerCase() === String(taskId).trim().toLowerCase())
    );
    if (!task && !isNaN(numIdx) && numIdx > 0 && report.tasks[numIdx - 1]) {
      task = report.tasks[numIdx - 1];
    }
    if (!task) return;

    if (task.status === 'Not Started') task.status = 'In Progress';
    else if (task.status === 'In Progress') task.status = 'Completed';
    else if (task.status === 'Completed') task.status = 'Needs Repair';
    else task.status = 'Not Started';

    task.updated = 'Just now';
    const allDone = report.tasks.every(t => t.status === 'Completed');
    const allVerified = report.tasks.every(t => t.status === 'Completed' && t.verified);
    const hasErr = report.tasks.some(t => t.status === 'Needs Repair');
    if (hasErr) {
      report.status = 'Needs Repair';
      const errTask = report.tasks.find(t => t.status === 'Needs Repair');
      if (errTask) {
        report.issue = {
          component: errTask.name,
          notes: errTask.notes || 'Maintenance defect requires repair.'
        };
      }
    } else {
      report.issue = null;
      if (allVerified) report.status = 'Completed';
      else if (allDone) report.status = 'For Verification';
      else if (report.tasks.some(t => t.status === 'In Progress' || t.status === 'Completed')) report.status = 'In Progress';
      else report.status = 'Pending';
    }

    saveReports(reports, report, false, true).catch(() => {});
    renderDetailModalContent();
  }

  window.EcoTrackMaintenance = {
    openCreateModal: openCreateReportModal,
    closeCreateModal: closeCreateReportModal,
    openDetailModal: openDetailModal,
    closeDetailModal: closeDetailModal,
    openEditModal: openEditReportModal,
    openChecklistItemModal: openChecklistItemModal,
    closeChecklistItemModal: closeChecklistItemModal,
    cycleTaskStatus: cycleTaskStatus,
    openRepairTaskModal: openRepairTaskModal,
    closeRepairTaskModal: closeRepairTaskModal,
    submitRepairTask: submitRepairTask,
    openEditRepairTaskModal: openEditRepairTaskModal,
    closeEditRepairTaskModal: closeEditRepairTaskModal,
    cycleRepairStepStatus: cycleRepairStepStatus,
    _updateEditRepStepName: _updateEditRepStepName,
    _removeEditRepStep: _removeEditRepStep,
    generateNextReportId: generateNextReportId,
    deleteReport: deleteReport,
    deleteReports: deleteReports,
    getReports: () => {const reports=getReports();if(window.EcoTrackMode?.mode!=='monitoring')return reports;const identities=new Set(getAirconsDatabase().flatMap(ac=>[ac.nodeId,ac.id]).filter(Boolean));return reports.filter(report=>[report.aircon_id,report.nodeId,report.airconId].some(id=>identities.has(id)));},
    deviceLabel:maintenanceDeviceLabel,
    resolveReportEquipment: maintenanceReportEquipment,
    fetchReports: fetchReportsFromSupabase,
    refreshReports: fetchReportsFromSupabase,
    invalidateCache: invalidateReportsCache,
    renderDetailModalContent: renderDetailModalContent,
    saveReports: saveReports,
    getAircons: () => AIRCONS_DATABASE,
    resolveStaffAvatar: resolveStaffAvatar,
    resolveStaffLocation: resolveStaffLocation,
    resolveStaffHierarchy: resolveStaffHierarchy,
    setLocationHierarchy: updateStaffLocationHierarchy,
    getAirconsForStaff: getAirconsForStaff,
    formatAcLocation: formatAcLocation,
    getStaffBuilding: getStaffBuilding,
    showToast: showToast,
    openImageLightbox: openImageLightbox,
    closeImageLightbox: closeImageLightbox
  };

})();
