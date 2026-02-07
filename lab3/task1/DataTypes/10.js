//task1.
let d1 = new Date(2012, 1, 20, 3, 12);
alert( d1 );

//task2.
function getWeekDay(date) {
    let days = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
    return days[date.getDay()];
  }
  let date = new Date(2014, 0, 3); // 3 Jan 2014
  alert( getWeekDay(date) );

//task3.
function getLocalDay(date) {
    let day = date.getDay();
    if (day == 0) { 
      day = 7;
    }
    return day;
  }

//task4.
function getDateAgo(data, days) {
    let dataCopy = new Date(data);
    dataCopy.setData(data.getData() - days);
    return dataCopy.getData();
  }
  let data = new Data(2015, 0, 2);
  alert( getDataAgo(date, 1) ); // 1, (1 Jan 2015)
  alert( getDataAgo(date, 2) ); // 31, (31 Dec 2014)
  alert( getDataAgo(date, 365) ); // 2, (2 Jan 2014)

//task5.
function getLastDayOfMonth(year, month) {
    let date = new Date(year, month + 1, 0);
    return date.getDate();
  }
  alert( getLastDayOfMonth(2012, 0) ); // 31
  alert( getLastDayOfMonth(2012, 1) ); // 29
  alert( getLastDayOfMonth(2013, 1) ); // 28

//task6.
function getSecondsToday() {
    let now = new Date();
    let today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let diff = now - today; 
    return Math.round(diff / 1000); 
  }
  alert( getSecondsToday() );

//task7.
function getSecondsToTomorrow() {
    let now = new Date();
    let tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate()+1);
    let diff = tomorrow - now; 
    return Math.round(diff / 1000); 
  }

//task8.
function formatDate(date) {
    let dayOfMonth = date.getDate();
    let month = date.getMonth() + 1;
    let year = date.getFullYear();
    let hour = date.getHours();
    let minutes = date.getMinutes();
    let diffMs = new Date() - date;
    let diffSec = Math.round(diffMs / 1000);
    let diffMin = diffSec / 60;
    let diffHour = diffMin / 60;
    year = year.toString().slice(-2);
    month = month < 10 ? '0' + month : month;
    dayOfMonth = dayOfMonth < 10 ? '0' + dayOfMonth : dayOfMonth;
    hour = hour < 10 ? '0' + hour : hour;
    minutes = minutes < 10 ? '0' + minutes : minutes;
    if (diffSec < 1) {
      return 'right now';
    } else if (diffMin < 1) {
      return `${diffSec} sec. ago`
    } else if (diffHour < 1) {
      return `${diffMin} min. ago`
    } else {
      return `${dayOfMonth}.${month}.${year} ${hour}:${minutes}`
    }
  }