


// Open Side Panel

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id }, () => {
  });
});
