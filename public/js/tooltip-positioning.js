/**
 * Smart tooltip positioning to prevent overlap and ensure visibility
 */

document.addEventListener('DOMContentLoaded', function() {
  function positionTooltip(tooltip, icon) {
    // Get icon position relative to viewport
    const iconRect = icon.getBoundingClientRect();
    
    // Find the chart container (closest glass-card parent)
    const chartContainer = icon.closest('section')?.querySelector('.glass-card');
    let chartRect = null;
    if (chartContainer) {
      chartRect = chartContainer.getBoundingClientRect();
    }
    
    // Tooltip dimensions
    const tooltipWidth = 280;
    const tooltipHeight = tooltip.offsetHeight || 120;
    const gap = 12;
    
    // Calculate available space
    const spaceAbove = iconRect.top;
    const spaceBelow = window.innerHeight - iconRect.bottom;
    const spaceLeft = iconRect.left;
    const spaceRight = window.innerWidth - iconRect.right;
    
    let top, left;
    let placement = 'bottom';
    
    // If icon is near top of viewport, always position below icon to prevent top clipping
    if (iconRect.top < 220 || spaceBelow >= tooltipHeight + gap) {
      top = iconRect.bottom + gap;
      left = Math.max(16, iconRect.left);
      placement = 'bottom';
    } else if (spaceRight > tooltipWidth + gap + 40) {
      // Position to the right
      left = iconRect.right + gap;
      top = Math.max(70, iconRect.top + iconRect.height / 2 - tooltipHeight / 2);
      placement = 'right';
    } else if (spaceLeft > tooltipWidth + gap) {
      // Position to the left
      left = iconRect.left - tooltipWidth - gap;
      top = Math.max(70, iconRect.top + iconRect.height / 2 - tooltipHeight / 2);
      placement = 'left';
    } else {
      // Position below
      top = iconRect.bottom + gap;
      left = Math.max(16, iconRect.left);
      placement = 'bottom';
    }
    
    // Ensure tooltip doesn't go off-screen horizontally
    const padding = 12;
    if (left < padding) {
      left = padding;
    } else if (left + tooltipWidth > window.innerWidth - padding) {
      left = window.innerWidth - tooltipWidth - padding;
    }
    
    // Ensure tooltip doesn't go off-screen vertically or into header
    const minTop = 68;
    if (top < minTop) {
      top = minTop;
    } else if (top + tooltipHeight > window.innerHeight - padding) {
      top = window.innerHeight - tooltipHeight - padding;
    }
    
    // Apply positioning
    tooltip.style.position = 'fixed';
    tooltip.style.top = Math.round(top) + 'px';
    tooltip.style.left = Math.round(left) + 'px';
    
    // Store placement for arrow styling
    tooltip.setAttribute('data-placement', placement);
  }
  
  // Setup all tooltips
  document.querySelectorAll('.info-tooltip').forEach(tooltipContainer => {
    const icon = tooltipContainer.querySelector('svg');
    const tooltipContent = tooltipContainer.querySelector('.tooltip-content');
    
    if (!icon || !tooltipContent) return;
    
    // Position on hover with small delay
    icon.addEventListener('mouseenter', function() {
      setTimeout(() => {
        positionTooltip(tooltipContent, icon);
      }, 0);
    });
    
    // Reposition on window resize and scroll
    window.addEventListener('resize', function() {
      if (tooltipContent.style.opacity !== '0') {
        positionTooltip(tooltipContent, icon);
      }
    });
    
    window.addEventListener('scroll', function() {
      if (tooltipContent.style.opacity !== '0') {
        positionTooltip(tooltipContent, icon);
      }
    });
  });
});
